// Proposing deterministic repairs for steps an approval gate refused.
//
// Every fixable diagnosis becomes at most one reviewable patch candidate on
// the version it was diagnosed against. Nothing here asks a model and nothing
// applies itself: a gate repair is `unsafe` by classification and never
// auto-applied (`shouldAutoApply`), so a person previews the exact operations
// and approves them through the ordinary patch-candidate review.
//
// Idempotent by construction. The workflow row lock serializes concurrent
// proposers (the repair queue and an explicit request), an open candidate for
// the same block is returned instead of a second one, and a rejected one keeps
// holding for that version — a person's "no" is not re-asked on every run.

import { and, eq } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { workflowVersions } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { recordPatchCandidate } from "../observability/instrumentation.ts";
import {
  diagnoseWorkflow,
  findGateCandidate,
  type GateDiagnosis,
  gateEndpointKey,
  planForDiagnosis,
} from "../workflows/gate-diagnosis.ts";
import type { GateFixer, GateFixPatch } from "../workflows/gate-fix.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import { persistPatchCandidate } from "./persist-candidate.ts";
import {
  findActiveEndpointCandidate,
  findMatchingTerminalEndpointCandidate,
} from "./terminal-dedup.ts";
import type { DriftSignal } from "./types.ts";

export interface GateRepairOutcome {
  candidate_id: string;
  step_id: string;
  fixer: GateFixer;
  status: string;
  /** False when an existing candidate already covers this block. */
  created: boolean;
}

export class GateRepairError extends Error {
  constructor(
    readonly code: "workflow_not_found" | "version_not_current" | "repair_not_available",
    message: string,
  ) {
    super(message);
  }
}

interface Target {
  tenant_id: string;
  workflow_id: string;
  version_id: string;
  environment: "dev" | "prod";
}

/**
 * Propose a candidate for every diagnosis of `version_id` that a fixer can
 * repair. A version that is no longer current gets none: readiness, prepare
 * and apply all read the current version, so a candidate against another one
 * would be checked against a definition that was never diagnosed.
 */
export async function proposeGateRepairs(db: Db, target: Target): Promise<GateRepairOutcome[]> {
  return db.transaction(async (tx) => {
    const locked = await lockCurrent(tx, target);
    if (!locked) return [];
    const outcomes: GateRepairOutcome[] = [];
    for (const diagnosis of locked.diagnoses) {
      const outcome = await proposeOne(tx, target, locked.dag, diagnosis);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  });
}

/**
 * Propose the one repair a person asked for by step and fixer. Refused unless
 * the current version's diagnosis offers exactly that repair: the operations
 * are always computed here, never taken from the caller.
 */
export async function proposeGateRepair(
  db: Db,
  params: {
    tenant_id: string;
    workflow_id: string;
    environment: "dev" | "prod";
    step_id: string;
    fixer: GateFixer;
  },
): Promise<GateRepairOutcome> {
  return db.transaction(async (tx) => {
    const workflow = await lockWorkflowForVersionWrite(tx, params.tenant_id, params.workflow_id);
    if (!workflow || workflow.deleted_at)
      throw new GateRepairError("workflow_not_found", "workflow not found");
    if (!workflow.current_version_id)
      throw new GateRepairError("version_not_current", "the workflow has no active version");
    const target = { ...params, version_id: workflow.current_version_id };
    const locked = await lockCurrent(tx, target);
    const diagnosis = locked?.diagnoses.find(
      (entry) => entry.subject.step_id === params.step_id && entry.fixer === params.fixer,
    );
    const outcome =
      locked && diagnosis ? await proposeOne(tx, target, locked.dag, diagnosis) : null;
    if (!outcome)
      throw new GateRepairError(
        "repair_not_available",
        `no ${params.fixer} repair is available for step ${params.step_id} in the active version`,
      );
    return outcome;
  });
}

async function lockCurrent(tx: Executor, target: Target) {
  const workflow = await lockWorkflowForVersionWrite(tx, target.tenant_id, target.workflow_id);
  if (!workflow || workflow.deleted_at || workflow.current_version_id !== target.version_id)
    return null;
  const diagnosis = await diagnoseWorkflow(
    tx,
    target.tenant_id,
    target.workflow_id,
    target.environment,
    { version_id: target.version_id },
  );
  if (!diagnosis) return null;
  const [version] = await tx
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, target.tenant_id),
        eq(workflowVersions.id, target.version_id),
      ),
    )
    .limit(1);
  return { dag: version?.dag, diagnoses: diagnosis.diagnoses.filter((entry) => entry.fixer) };
}

const DESCRIPTIONS: Record<GateFixer, (step_id: string) => string> = {
  use_utf8_encoder: (step_id) =>
    `Encode the report message as UTF-8 in step \`${step_id}\`: replace sk.base64UrlEncode( with sk.base64UrlEncodeUtf8(.`,
  declare_report_delivery: (step_id) =>
    `Declare the recipient a preparation observed on step \`${step_id}\` as its reviewed report delivery.`,
};

async function proposeOne(
  tx: Executor,
  target: Target,
  dag: unknown,
  diagnosis: GateDiagnosis,
): Promise<GateRepairOutcome | null> {
  const fixer = diagnosis.fixer;
  const plan = fixer ? planForDiagnosis(dag, diagnosis) : null;
  if (!fixer || !plan) return null;
  const step_id = diagnosis.subject.step_id;
  const signal: DriftSignal = {
    kind: "gate_block",
    code: diagnosis.code,
    reason: diagnosis.reason ?? null,
    fixer,
    step_id,
  };
  const endpoint_key = gateEndpointKey(diagnosis.code);
  const anchor = {
    tenant_id: target.tenant_id,
    workflow_id: target.workflow_id,
    connector_id: null,
    endpoint_key,
    signal,
    base_version_id: target.version_id,
    workflow_step_id: plan.step_id,
  };
  // The same block under the same gate code, through the drift dedup every
  // candidate uses; then the same repair recorded under another code for this
  // version — a rejection of it is the person's answer to this one too.
  const existing =
    (await findActiveEndpointCandidate(tx, anchor)) ??
    (await findMatchingTerminalEndpointCandidate(tx, { ...anchor, step_id: null })) ??
    (await findGateCandidate(
      tx,
      { ...target, workflow_version_id: target.version_id },
      { step_id, fixer },
      ["proposed", "applied", "rejected"],
    ));
  if (existing)
    return { candidate_id: existing.id, step_id, fixer, status: existing.status, created: false };
  const patch: GateFixPatch = {
    fixer,
    step_id: plan.step_id,
    subject_step_id: step_id,
    ops: plan.ops,
    ...(fixer === "declare_report_delivery" && diagnosis.evidence.execution_id
      ? { source_execution_id: diagnosis.evidence.execution_id }
      : {}),
  };
  const proposal: PatchProposal = {
    classification: "unsafe",
    kind: "gate_fix",
    description: DESCRIPTIONS[fixer](plan.step_id),
    patch,
    reasoning: `The approval gate refused step \`${step_id}\` with \`${diagnosis.code}\`; the ${fixer} fixer computed this change from the saved definition${diagnosis.evidence.execution_id ? ` and run ${diagnosis.evidence.execution_id}` : ""}.`,
  };
  const { candidate, closed } = await persistPatchCandidate(tx, {
    tenant_id: target.tenant_id,
    workflow_id: target.workflow_id,
    connector_id: null,
    endpoint_key,
    classification: "unsafe",
    diff: {
      base_version_id: target.version_id,
      drift_signal: signal,
      proposal,
      workflow_step_id: plan.step_id,
      step_id,
      execution_id: diagnosis.evidence.execution_id ?? null,
      environment: target.environment,
      source: "gate_block",
      classification_reasons: ["gate_repair_requires_review"],
    },
    audit_metadata: {
      drift_kind: "gate_block",
      source: "gate_block",
      code: diagnosis.code,
      fixer,
      step_id,
    },
    event_payload: { source: "gate_block", fixer, step_id },
  });
  if (!closed) recordPatchCandidate({ classification: "unsafe", decision: "parked" });
  return {
    candidate_id: candidate.id,
    step_id,
    fixer,
    status: closed ? "inapplicable" : "proposed",
    created: true,
  };
}
