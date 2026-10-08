import { type Actor, auditActor } from "../audit/actor.ts";
import { audit } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { containsOffloadRef } from "../execution/offload-rehydrate.ts";
import type { RunResult } from "../execution/types.ts";
import { logger } from "../logging/logger.ts";
import { recordConversationRepair } from "../observability/instrumentation.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { getWorkflowDraft, withWorkflowDraft } from "./authoring-state.ts";
import { type WorkflowOutputSite, workflowOutputSite } from "./dry-run-repair.ts";
import {
  repairTransformExpression,
  type TransformEvaluation,
  type TransformRepairFinding,
} from "./transform-repair.ts";
import type { DraftDocument } from "./types.ts";

export type PreviewAutoRepairTrigger = "output_transform_failed" | "output_contract_violation";

export const PREVIEW_AUTO_REPAIRED_WARNING_CODE = "preview.auto_repaired" as const;

export const WORKFLOW_OUTPUT_AUTO_REPAIRED_ACTION = "workflow_output_auto_repaired" as const;

type RunStep = RunResult["steps"][number];

function containerChildIds(definition: WorkflowDef): Set<string> {
  const children = new Set<string>();
  for (const step of definition.steps) {
    if (step.kind === "loop") {
      for (const id of step.body ?? []) children.add(id);
    } else if (step.kind === "parallel") {
      for (const branch of step.branches ?? []) for (const id of branch ?? []) children.add(id);
    }
  }
  return children;
}

function contractViolationWarning(run: RunResult): { message: string } | null {
  const warning = (run.warnings ?? []).find((w) => w.code === "output_contract_violation");
  return warning ? { message: warning.message } : null;
}

export function previewAutoRepairTrigger(
  run: RunResult,
  definition: WorkflowDef,
): PreviewAutoRepairTrigger | null {
  const trigger: PreviewAutoRepairTrigger | null =
    run.error?.code === "output_transform_failed"
      ? "output_transform_failed"
      : run.status === "succeeded" && contractViolationWarning(run)
        ? "output_contract_violation"
        : null;
  if (!trigger) return null;
  if (run.steps.length === 0) return null;
  if (run.steps.some((s) => s.status !== "succeeded" || s.held === true)) return null;
  if (workflowOutputSite(definition) === null) return null;
  return trigger;
}

export function buildStepOutputFixtures(steps: ReadonlyArray<RunStep>): Record<string, unknown> {
  const fixtures: Record<string, unknown> = {};
  for (const s of steps) {
    if (s.status !== "succeeded" || s.output_preview === undefined) continue;
    const rm = (s.request_meta ?? null) as { status?: unknown; headers?: unknown } | null;
    fixtures[s.step_key] = {
      data: s.output_preview,
      duration_ms: s.duration_ms ?? 0,
      error: null,
      ...(rm && typeof rm.status === "number" ? { status_code: rm.status } : {}),
      ...(rm?.headers && typeof rm.headers === "object"
        ? { headers: rm.headers as Record<string, string> }
        : {}),
    };
  }
  return fixtures;
}

export type PreviewOutputRoot = { ok: true; root: unknown } | { ok: false };

export function previewOutputRoot(run: RunResult, definition: WorkflowDef): PreviewOutputRoot {
  const children = containerChildIds(definition);
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    if (!step || children.has(step.step_key)) continue;
    if (step.status !== "succeeded") continue;
    if (step.output_preview === undefined || containsOffloadRef(step.output_preview)) {
      return { ok: false };
    }
    return { ok: true, root: step.output_preview };
  }
  return { ok: false };
}

export function workflowOutputEvaluation(p: {
  run: RunResult;
  definition: WorkflowDef;
  scope: Record<string, unknown>;
  input: unknown;
}): TransformEvaluation | null {
  const root = previewOutputRoot(p.run, p.definition);
  if (!root.ok) return null;
  return {
    kind: "workflow_output",
    root: root.root,
    scope: p.scope,
    input: p.input,
    output_schema: p.definition.output_schema ?? null,
  };
}

export interface PreviewAutoRepair {
  site: WorkflowOutputSite["site"];
  before: string;
  after: string;
  attempts: number;
  replaced_execution_id: string;
}

export type PreviewAutoRepairOutcome =
  | { repaired: true; auto_repair: PreviewAutoRepair; definition: WorkflowDef; run: RunResult }
  | {
      repaired: false;
      reason: "not_applicable" | "repair_failed" | "rerun_failed";
      attempts: number;
    };

function repairFinding(trigger: PreviewAutoRepairTrigger, run: RunResult): TransformRepairFinding {
  if (trigger === "output_transform_failed") {
    return { kind: "eval_error", message: run.error?.message ?? "output transform threw" };
  }
  return {
    kind: "eval_error",
    message:
      contractViolationWarning(run)?.message ??
      "final output does not satisfy the workflow's output_schema",
  };
}

export async function attemptPreviewAutoRepair(p: {
  run: RunResult;
  definition: WorkflowDef;
  previewInput: unknown;
  tenant_id: string;
  db: Db;
  rerun: (
    definition: WorkflowDef,
    step_output_fixtures: Record<string, unknown>,
  ) => Promise<RunResult>;
  signal?: AbortSignal;
}): Promise<PreviewAutoRepairOutcome> {
  const trigger = previewAutoRepairTrigger(p.run, p.definition);
  const site = workflowOutputSite(p.definition);
  if (!trigger || !site) return { repaired: false, reason: "not_applicable", attempts: 0 };
  const fixtures = buildStepOutputFixtures(p.run.steps);
  if (Object.keys(fixtures).length !== p.run.steps.length) {
    return { repaired: false, reason: "not_applicable", attempts: 0 };
  }
  const evaluation = workflowOutputEvaluation({
    run: p.run,
    definition: p.definition,
    scope: fixtures,
    input: p.previewInput,
  });
  if (!evaluation) return { repaired: false, reason: "not_applicable", attempts: 0 };

  const repair = await repairTransformExpression({
    expression: site.expression,
    language: site.language,
    finding: repairFinding(trigger, p.run),
    evaluation,
    site: site.site,
    tenant_id: p.tenant_id,
    db: p.db,
    ...(p.signal ? { signal: p.signal } : {}),
  });
  if (!repair.repaired) {
    logger.info({
      module: "conversations",
      action: "preview_auto_repair.repair_failed",
      msg: "in-preview auto-repair found no verified candidate for the workflow output site",
      tenant_id: p.tenant_id,
      trigger,
      site: site.site,
      attempts: repair.attempts,
      last_error: repair.last_error,
    });
    return { repaired: false, reason: "repair_failed", attempts: repair.attempts };
  }

  const definition: WorkflowDef = { ...p.definition, [site.site]: repair.after };
  let rerun: RunResult;
  try {
    rerun = await p.rerun(definition, fixtures);
  } catch (err) {
    logger.warn({
      module: "conversations",
      action: "preview_auto_repair.rerun_threw",
      msg: "fixture re-run of the repaired definition threw — keeping the original preview",
      tenant_id: p.tenant_id,
      site: site.site,
      error: err instanceof Error ? err.message : String(err),
    });
    return { repaired: false, reason: "rerun_failed", attempts: repair.attempts };
  }
  if (rerun.status !== "succeeded" || contractViolationWarning(rerun)) {
    logger.info({
      module: "conversations",
      action: "preview_auto_repair.rerun_failed",
      msg: "fixture re-run of the repaired definition did not come back green — keeping the original preview",
      tenant_id: p.tenant_id,
      site: site.site,
      rerun_status: rerun.status,
      rerun_error: rerun.error?.code ?? null,
    });
    return { repaired: false, reason: "rerun_failed", attempts: repair.attempts };
  }
  logger.info({
    module: "conversations",
    action: "preview_auto_repair.repaired",
    msg: "workflow output site repaired inside the preview and verified by a fixture re-run",
    tenant_id: p.tenant_id,
    trigger,
    site: site.site,
    attempts: repair.attempts,
    replaced_execution_id: p.run.execution_id,
    execution_id: rerun.execution_id,
  });
  return {
    repaired: true,
    auto_repair: {
      site: site.site,
      before: repair.before,
      after: repair.after,
      attempts: repair.attempts,
      replaced_execution_id: p.run.execution_id,
    },
    definition,
    run: rerun,
  };
}

export function previewAutoRepairWarning(auto_repair: PreviewAutoRepair): {
  step_key: "$output";
  code: typeof PREVIEW_AUTO_REPAIRED_WARNING_CODE;
  message: string;
} {
  return {
    step_key: "$output",
    code: PREVIEW_AUTO_REPAIRED_WARNING_CODE,
    message: `${auto_repair.site} threw or violated the output contract in this preview and was repaired automatically (${auto_repair.attempts} attempt${auto_repair.attempts === 1 ? "" : "s"}); the draft now carries the verified expression and the shown output comes from its fixture re-run (replaced execution ${auto_repair.replaced_execution_id}).`,
  };
}

export function recordPreviewAutoRepairOutcome(p: {
  outcome: PreviewAutoRepairOutcome;
  draft: DraftDocument;
  tenant_id: string;
  conversation_id: string;
  actor: Actor | null;
  db: Db;
}): DraftDocument {
  if (!p.outcome.repaired) {
    if (p.outcome.reason === "repair_failed") recordConversationRepair({ kind: "capped" });
    return p.draft;
  }
  const { auto_repair, run } = p.outcome;
  recordConversationRepair({ kind: "repaired" });
  audit(
    {
      tenant_id: p.tenant_id,
      ...auditActor(p.actor),
      action: AuditAction.WORKFLOW_PREVIEW_AUTO_REPAIRED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: {
        site: auto_repair.site,
        attempts: auto_repair.attempts,
        replaced_execution_id: auto_repair.replaced_execution_id,
        execution_id: run.execution_id,
      },
    },
    p.db,
  );
  return withWorkflowDraft(
    p.draft,
    { ...getWorkflowDraft(p.draft), [auto_repair.site]: auto_repair.after },
    WORKFLOW_OUTPUT_AUTO_REPAIRED_ACTION,
  );
}
