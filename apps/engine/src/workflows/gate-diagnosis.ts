// Why an approval gate holds a workflow, and what removes it — asked once.
//
// The gate already says what is wrong in four places: the manifest's issues,
// the request and storage refusals beside it, the connectors that cannot
// serve, and — after approval — the step a granted run was refused at. Each
// surface used to read one of them and infer the rest. `diagnoseWorkflow` is
// the single producer: every surface (HTTP, the conversation tools, the
// automation review, the repair queue) reads the same diagnoses, so a remedy
// shown in one place is the remedy proposed in another.
//
// It only reads. Proposing a repair is `proposeGateRepairs` in self-healing;
// this module looks up a candidate that already exists, never creates one.

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  executionSteps,
  executions,
  patchCandidates,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { GOVERNANCE_REFUSALS } from "../execution/state.ts";
import type { ManifestIssueCode } from "./effect-manifest.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";
import {
  type GateFixer,
  type GateFixPlan,
  planReportDeliveryDeclaration,
  planUtf8EncoderFix,
} from "./gate-fix.ts";
import {
  GMAIL_SEND_TARGET,
  type ReportDeliveryBoundary,
  ReportDeliveryBoundarySchema,
} from "./report-delivery-boundary.ts";
import { inspectHeldPreviewEvidence } from "./report-delivery-proposal.ts";
import type { RequestBoundaryRefusal } from "./request-boundary.ts";
import type { StorageBoundaryRefusal } from "./storage-boundary.ts";

export type GateDiagnosisCode =
  | ManifestIssueCode
  | RequestBoundaryRefusal
  | StorageBoundaryRefusal
  | "execution_authority_changed"
  | "connector_unavailable";

/** What kind of act removes the block. `patch` is the only one a fixer can
 *  perform; the others name what a person (or an author) has to do. */
export type GateRemedyKind = "patch" | "prepare" | "declare" | "reconnect" | "author";

export interface GateDiagnosis {
  code: GateDiagnosisCode;
  subject: { step_id: string; field?: string };
  evidence: {
    /** The run the diagnosis rests on, when it rests on one. */
    execution_id?: string;
    /** Addresses a successful inspection observed — never message content. */
    observed?: { to: string; from: string; content_type: ReportDeliveryBoundary["content_type"] };
  };
  remedy_kind: GateRemedyKind;
  /** Present only when a deterministic fixer computes the repair. */
  fixer?: GateFixer;
  /** The open repair candidate for this diagnosis, when one was proposed. */
  candidate_id?: string;
}

export interface WorkflowDiagnosis {
  workflow_id: string;
  workflow_version_id: string | null;
  environment: "dev" | "prod";
  /** Whether the diagnosed version is the one runs use. A repair can only be
   *  proposed against the current version — a draft is diagnosed, not fixed. */
  is_current: boolean;
  diagnoses: GateDiagnosis[];
}

type Preview = Awaited<ReturnType<typeof previewWorkflowAuthority>>;
type HeldEvidence = Awaited<ReturnType<typeof inspectHeldPreviewEvidence>>;

/** A loop body records `send[0]`, `send[1]`, … — the same step. */
const stepKeyOf = (key: string) => key.replace(/\[[0-9]+\]$/, "");

export function gateEndpointKey(code: string): string {
  return `gate:${code}`;
}

/**
 * Diagnose a workflow's saved version in one environment.
 *
 * The version is the draft when there is one and the current version
 * otherwise — the same choice the automation review makes. `preview` and
 * `held` let a caller that already computed them avoid a second pass.
 */
export async function diagnoseWorkflow(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  environment: "dev" | "prod",
  options: { version_id?: string; preview?: Preview; held?: HeldEvidence } = {},
): Promise<WorkflowDiagnosis | null> {
  const [workflow] = await db
    .select({
      current_version_id: workflows.current_version_id,
      draft_version_id: workflows.draft_version_id,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!workflow) return null;
  const version_id =
    options.version_id ?? workflow.draft_version_id ?? workflow.current_version_id ?? null;
  const base = {
    workflow_id,
    workflow_version_id: version_id,
    environment,
    is_current: version_id !== null && version_id === workflow.current_version_id,
  };
  if (!version_id) return { ...base, diagnoses: [] };
  const input = {
    tenant_id,
    workflow_id,
    workflow_version_id: version_id,
    execution_environment: environment,
  };
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, workflow_id),
        eq(workflowVersions.id, version_id),
      ),
    )
    .limit(1);
  if (!version) return { ...base, diagnoses: [] };
  const preview = options.preview ?? (await previewWorkflowAuthority(input, db));
  const held =
    options.held !== undefined ? options.held : await inspectHeldPreviewEvidence(input, db);
  const refused = await newestRefusedStep(db, input);
  const diagnoses = collapse(
    await buildDiagnoses(db, { ...input, definition: version.dag, preview, held, refused }),
  );
  await attachCandidates(db, input, diagnoses);
  return { ...base, diagnoses };
}

/** The newest step a granted run of exactly this version was refused at.
 *  Read from the step row — the run's own record — not from the audit log,
 *  whose reasons sit behind their own read permission. */
async function newestRefusedStep(
  db: Executor,
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
) {
  const [row] = await db
    .select({
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      error: executionSteps.error,
    })
    .from(executionSteps)
    .innerJoin(
      executions,
      and(
        eq(executions.id, executionSteps.execution_id),
        eq(executions.tenant_id, executionSteps.tenant_id),
      ),
    )
    .where(
      and(
        eq(executionSteps.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.workflow_version_id, input.workflow_version_id),
        eq(executions.execution_mode, input.execution_environment),
        isNotNull(executions.execution_authority_id),
        inArray(sql<string>`${executionSteps.error}->>'code'`, [...GOVERNANCE_REFUSALS]),
      ),
    )
    .orderBy(desc(executions.created_at), desc(executionSteps.started_at))
    .limit(1);
  if (!row) return null;
  return { execution_id: row.execution_id, step_id: stepKeyOf(row.step_key), error: row.error };
}

interface DiagnosisInput {
  tenant_id: string;
  workflow_id: string;
  workflow_version_id: string;
  execution_environment: "dev" | "prod";
  definition: unknown;
  preview: Preview;
  held: HeldEvidence;
  refused: Awaited<ReturnType<typeof newestRefusedStep>>;
}

async function buildDiagnoses(db: Executor, input: DiagnosisInput): Promise<GateDiagnosis[]> {
  const { preview, refused } = input;
  const out: GateDiagnosis[] = [];
  const refusedSteps = new Set<string>();
  for (const refusal of preview.request_refusals) {
    // A refusal inside a called workflow is repaired THERE; this workflow can
    // only name the call step that starts it.
    const step_id = refusal.call_path?.[0] ?? refusal.step_id;
    refusedSteps.add(step_id);
    if (refusal.call_path) {
      out.push({ code: refusal.reason, subject: { step_id }, evidence: {}, remedy_kind: "author" });
      continue;
    }
    out.push(await requestDiagnosis(db, input, refusal.step_id, refusal.reason));
  }
  for (const refusal of preview.storage_refusals) {
    const step_id = refusal.call_path?.[0] ?? refusal.step_id;
    refusedSteps.add(step_id);
    out.push({ code: refusal.reason, subject: { step_id }, evidence: {}, remedy_kind: "author" });
  }
  for (const issue of preview.manifest.issues) {
    // `dynamic_request` is what every refusal above explains in detail; the
    // generic code beside its specific reason would be the same block twice.
    if (issue.code === "dynamic_request" && refusedSteps.has(issue.step_id)) continue;
    out.push({
      code: issue.code,
      subject: { step_id: issue.step_id },
      evidence: {},
      remedy_kind: "author",
    });
  }
  for (const connector of preview.unavailable_connectors) {
    out.push({
      code: "connector_unavailable",
      subject: { step_id: connector.step_id },
      evidence: {},
      remedy_kind: "reconnect",
    });
  }
  if (refused) {
    const reason = refusalReason(refused.error);
    const plan = reason ? encoderPlan(input.definition, refused.step_id, reason) : null;
    out.push({
      code: "execution_authority_changed",
      subject: { step_id: refused.step_id },
      evidence: { execution_id: refused.execution_id },
      ...(plan
        ? { remedy_kind: "patch", fixer: "use_utf8_encoder" }
        : { remedy_kind: reason ? "author" : "prepare" }),
    });
  }
  return out;
}

/** The operations a diagnosis's fixer computes against a definition, or null
 *  when it has no fixer or the definition no longer supports the fix. */
export function planForDiagnosis(
  definition: unknown,
  diagnosis: GateDiagnosis,
): GateFixPlan | null {
  if (diagnosis.fixer === "use_utf8_encoder")
    return planUtf8EncoderFix(definition, diagnosis.subject.step_id);
  if (diagnosis.fixer === "declare_report_delivery" && diagnosis.evidence.observed)
    return planReportDeliveryDeclaration(
      definition,
      diagnosis.subject.step_id,
      diagnosis.evidence.observed,
    );
  return null;
}

/** The report gate's refusal reason recorded on a refused step, if any. */
function refusalReason(error: unknown): string | null {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? reason : null;
}

/** Reasons a binary encoder produces, and the UTF-8 encoder removes. */
const ENCODER_REASONS: ReadonlySet<string> = new Set(["not_utf8", "header_control_byte"]);

function encoderPlan(definition: unknown, step_id: string, reason: string): GateFixPlan | null {
  return ENCODER_REASONS.has(reason) ? planUtf8EncoderFix(definition, step_id) : null;
}

async function requestDiagnosis(
  db: Executor,
  input: DiagnosisInput,
  step_id: string,
  code: RequestBoundaryRefusal,
): Promise<GateDiagnosis> {
  const subject = { step_id };
  if (code === "report_delivery_unprepared")
    return { code, subject, evidence: {}, remedy_kind: "prepare" };
  if (code === "report_delivery_unreachable") {
    const observation = await successfulObservation(db, input, step_id);
    const plan = observation
      ? planReportDeliveryDeclaration(input.definition, step_id, observation.observed)
      : null;
    return plan && observation
      ? {
          code,
          subject,
          evidence: { execution_id: observation.execution_id, observed: observation.observed },
          remedy_kind: "declare",
          fixer: "declare_report_delivery",
        }
      : { code, subject, evidence: {}, remedy_kind: "declare" };
  }
  return {
    code,
    subject,
    evidence: input.held ? { execution_id: input.held.execution_id } : {},
    remedy_kind: "author",
  };
}

/**
 * The newest recorded successful inspection of this very step against the
 * report target, from any held run of this workflow in this environment.
 * The declaration copies what a run observed — never what a transform's
 * source text appears to say.
 */
async function successfulObservation(db: Executor, input: DiagnosisInput, step_id: string) {
  const rows = await db
    .select({
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      meta: executionSteps.request_meta,
    })
    .from(executionSteps)
    .innerJoin(
      executions,
      and(
        eq(executions.id, executionSteps.execution_id),
        eq(executions.tenant_id, executionSteps.tenant_id),
      ),
    )
    .where(
      and(
        eq(executionSteps.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.execution_mode, input.execution_environment),
        eq(executions.hold_writes, true),
        sql`(${executionSteps.step_key} = ${step_id} OR ${executionSteps.step_key} ~ ${`^${escapeRegex(step_id)}\\[[0-9]+\\]$`})`,
      ),
    )
    .orderBy(desc(executions.created_at), desc(executionSteps.started_at))
    .limit(20);
  for (const row of rows) {
    const meta = row.meta as {
      url?: unknown;
      extras?: { held?: boolean; report_delivery_proposal?: unknown };
    } | null;
    if (meta?.extras?.held !== true || meta.url !== GMAIL_SEND_TARGET) continue;
    const observed = ReportDeliveryBoundarySchema.safeParse(meta.extras.report_delivery_proposal);
    if (!observed.success) continue;
    const { to, from, content_type } = observed.data;
    return { execution_id: row.execution_id, observed: { to, from, content_type } };
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One diagnosis per fix. A held preview and a refused granted run can name the
 * same cause under two codes; proposing both would put the same operations in
 * front of a person twice. The first diagnosis wins — the gate's own preview
 * comes before the run evidence — and keeps the run's id when it had none.
 */
function collapse(diagnoses: GateDiagnosis[]): GateDiagnosis[] {
  const byFix = new Map<string, GateDiagnosis>();
  const seen = new Set<string>();
  const out: GateDiagnosis[] = [];
  for (const diagnosis of diagnoses) {
    const identity = `${diagnosis.subject.step_id}\u0000${diagnosis.code}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (diagnosis.fixer) {
      const key = `${diagnosis.subject.step_id}\u0000${diagnosis.fixer}`;
      const kept = byFix.get(key);
      if (kept) {
        if (!kept.evidence.execution_id && diagnosis.evidence.execution_id)
          kept.evidence.execution_id = diagnosis.evidence.execution_id;
        continue;
      }
      byFix.set(key, diagnosis);
    }
    out.push(diagnosis);
  }
  return out;
}

/** Attach the open gate-repair candidate for each fixable diagnosis. */
async function attachCandidates(
  db: Executor,
  input: { tenant_id: string; workflow_id: string; workflow_version_id: string },
  diagnoses: GateDiagnosis[],
) {
  const fixable = diagnoses.filter((diagnosis) => diagnosis.fixer);
  if (fixable.length === 0) return;
  const rows = await db
    .select({
      id: patchCandidates.id,
      endpoint_key: patchCandidates.endpoint_key,
      diff: patchCandidates.diff,
    })
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, input.tenant_id),
        eq(patchCandidates.workflow_id, input.workflow_id),
        eq(patchCandidates.status, "proposed"),
        inArray(
          patchCandidates.endpoint_key,
          fixable.map((diagnosis) => gateEndpointKey(diagnosis.code)),
        ),
      ),
    )
    .orderBy(desc(patchCandidates.created_at));
  for (const diagnosis of fixable) {
    const match = rows.find((row) => {
      const diff = row.diff as {
        base_version_id?: unknown;
        drift_signal?: { kind?: unknown; step_id?: unknown; fixer?: unknown };
      } | null;
      return (
        row.endpoint_key === gateEndpointKey(diagnosis.code) &&
        diff?.base_version_id === input.workflow_version_id &&
        diff.drift_signal?.kind === "gate_block" &&
        diff.drift_signal.step_id === diagnosis.subject.step_id &&
        diff.drift_signal.fixer === diagnosis.fixer
      );
    });
    if (match) diagnosis.candidate_id = match.id;
  }
}
