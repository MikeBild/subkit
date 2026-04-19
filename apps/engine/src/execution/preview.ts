// Authoring-time step + workflow preview.
//
// Reuses the real step drivers (request, transform) against the existing
// connectors, but bypasses step-runner.ts so no execution/step rows are
// written and no offload is performed. The only side effect is the outbound
// HTTP/GraphQL request a `request` step must make — which is already the
// whole point of previewing a connector-bound step.
//
// Classification taxonomy matches apps/engine/src/self-healing so a failed
// preview can surface as a patch candidate without a second mapping layer.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.ts";
import type { StepDef } from "../workflows/types.ts";
import { runRequestStep } from "./steps/request.ts";
import { runTransformStep } from "./steps/transform.ts";
import type { ExecutionMode, StepResult, StepRunContext } from "./types.ts";

export type PreviewClassification =
  | "ok"
  | "auth_failed"
  | "placeholder_unresolved"
  | "schema_mismatch"
  | "timeout"
  | "aborted"
  | "connector_missing"
  | "driver_error"
  | "preview_unsupported"
  | "unknown";

export interface PreviewStepSummary {
  ok: boolean;
  step_id: string;
  kind: string;
  duration_ms: number;
  classification: PreviewClassification;
  summary: string;
  output_preview?: unknown;
  error?: { code: string; message: string };
}

export interface PreviewWorkflowSummary {
  ok: boolean;
  steps_ran: number;
  duration_ms: number;
  stopped_at_step_id: string | null;
  classification: PreviewClassification;
  summary: string;
  last_step?: PreviewStepSummary;
}

const DEFAULT_BUDGET_MS = 5_000;

export interface PreviewStepParams {
  db: Db;
  tenant_id: string;
  step: StepDef;
  step_index?: number;
  scope?: Record<string, unknown>;
  workflow_input?: unknown;
  execution_mode?: ExecutionMode;
  signal?: AbortSignal;
  budget_ms?: number;
}

export async function previewStep(params: PreviewStepParams): Promise<PreviewStepSummary> {
  const started = Date.now();
  const step = params.step;
  const budget = Math.max(500, Math.min(60_000, params.budget_ms ?? DEFAULT_BUDGET_MS));

  // A preview-only abort controller enforces the wall-clock budget on top
  // of any caller signal (e.g. Ink `Esc`). Both feed into StepRunContext.
  const budgetCtrl = new AbortController();
  const timer = setTimeout(() => budgetCtrl.abort("preview_budget_exceeded"), budget);
  const outerSignal = params.signal;
  const composite = new AbortController();
  const onOuterAbort = (): void => composite.abort(outerSignal?.reason ?? "outer_abort");
  if (outerSignal) {
    if (outerSignal.aborted) composite.abort(outerSignal.reason ?? "outer_abort");
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const onBudgetAbort = (): void => composite.abort("preview_budget_exceeded");
  if (budgetCtrl.signal.aborted) composite.abort("preview_budget_exceeded");
  else budgetCtrl.signal.addEventListener("abort", onBudgetAbort, { once: true });

  const ctx = buildPreviewContext({
    db: params.db,
    tenant_id: params.tenant_id,
    step,
    step_index: params.step_index ?? 0,
    scope: params.scope ?? {},
    signal: composite.signal,
    execution_mode: params.execution_mode ?? "dev",
  });

  try {
    let result: StepResult;
    if (step.kind === "request") {
      result = await runRequestStep({ ctx, step, scope: ctx.scope });
    } else if (step.kind === "transform") {
      result = await runTransformStep({
        ctx,
        step,
        scope: ctx.scope,
        input: params.workflow_input ?? null,
      });
    } else if (step.kind === "wait") {
      // A real wait would sleep; preview never sleeps — we report the
      // declared duration so the user can verify the shape without
      // burning the budget.
      const ms =
        typeof (step as { duration_ms?: number }).duration_ms === "number"
          ? (step as { duration_ms: number }).duration_ms
          : 0;
      return {
        ok: true,
        step_id: step.id,
        kind: step.kind,
        duration_ms: Date.now() - started,
        classification: "ok",
        summary: `Wait step would pause for ${ms}ms at run time (preview skipped the sleep).`,
        output_preview: { would_wait_ms: ms },
      };
    } else if (step.kind === "branch") {
      // Preview a branch by evaluating its `when` condition against the
      // current scope + input. The children referenced by then/else ids
      // are shown but not executed — they'll run on their own row.
      const when = (step as { when?: string }).when ?? "";
      const then_steps = (step as { then_steps?: string[] }).then_steps ?? [];
      const else_steps = (step as { else_steps?: string[] }).else_steps ?? [];
      let taken: "then" | "else" | "unknown" = "unknown";
      try {
        if (when.length > 0) {
          const jsonata = (await import("jsonata")).default;
          const out = await jsonata(when).evaluate(ctx.scope, {
            input: params.workflow_input ?? null,
          });
          taken = out ? "then" : "else";
        }
      } catch {
        taken = "unknown";
      }
      return {
        ok: true,
        step_id: step.id,
        kind: step.kind,
        duration_ms: Date.now() - started,
        classification: "ok",
        summary:
          taken === "unknown"
            ? `Branch condition \`${when}\` was not evaluable in preview scope.`
            : `Branch would take the ${taken} arm at run time.`,
        output_preview: { taken, then_steps, else_steps },
      };
    } else if (step.kind === "parallel") {
      const branches = (step as { branches?: string[][] }).branches ?? [];
      return {
        ok: true,
        step_id: step.id,
        kind: step.kind,
        duration_ms: Date.now() - started,
        classification: "ok",
        summary: `Parallel step would fan out ${branches.length} branch${branches.length === 1 ? "" : "es"} at run time.`,
        output_preview: { branches },
      };
    } else if (step.kind === "loop") {
      const over = (step as { over?: string }).over ?? "";
      const body = (step as { body?: string[] }).body ?? [];
      const item_var = (step as { item_var?: string }).item_var ?? "item";
      return {
        ok: true,
        step_id: step.id,
        kind: step.kind,
        duration_ms: Date.now() - started,
        classification: "ok",
        summary: `Loop step would iterate over \`${over}\` into \`$${item_var}\` across ${body.length} body step${body.length === 1 ? "" : "s"}.`,
        output_preview: { over, item_var, body },
      };
    } else if (step.kind === "call") {
      const workflow_id = (step as { workflow_id?: string }).workflow_id;
      const workflow_slug = (step as { workflow_slug?: string }).workflow_slug;
      const target = workflow_slug ?? workflow_id ?? "(unspecified)";
      return {
        ok: true,
        step_id: step.id,
        kind: step.kind,
        duration_ms: Date.now() - started,
        classification: "ok",
        summary: `Call step would invoke workflow \`${target}\` at run time (sub-workflow not previewed).`,
        output_preview: {
          target,
          workflow_id: workflow_id ?? null,
          workflow_slug: workflow_slug ?? null,
        },
      };
    } else if (step.kind === "tool") {
      const image = (step as { image?: string }).image ?? "(no image)";
      return {
        ok: true,
        step_id: step.id,
        kind: step.kind,
        duration_ms: Date.now() - started,
        classification: "ok",
        summary: `Tool step would launch container \`${image}\` at run time (sandbox not previewed).`,
        output_preview: { image },
      };
    } else {
      // All current step kinds are covered above; this branch exists for
      // forward compatibility if a new kind lands without a preview impl.
      const fallback = step as unknown as { id: string; kind: string };
      return {
        ok: false,
        step_id: fallback.id,
        kind: fallback.kind,
        duration_ms: Date.now() - started,
        classification: "preview_unsupported",
        summary: `Preview is not yet supported for \`${fallback.kind}\` steps.`,
      };
    }
    return summarizeStepResult(step, result, Date.now() - started);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = budgetCtrl.signal.aborted || outerSignal?.aborted || /abort/i.test(message);
    return {
      ok: false,
      step_id: step.id,
      kind: step.kind,
      duration_ms: Date.now() - started,
      classification: aborted
        ? budgetCtrl.signal.aborted && !outerSignal?.aborted
          ? "timeout"
          : "aborted"
        : "driver_error",
      summary: aborted ? "Preview aborted before the step returned." : `Preview failed: ${message}`,
      error: { code: "preview_failed", message },
    };
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
    budgetCtrl.signal.removeEventListener("abort", onBudgetAbort);
  }
}

export interface PreviewWorkflowParams {
  db: Db;
  tenant_id: string;
  steps: StepDef[];
  workflow_input?: unknown;
  execution_mode?: ExecutionMode;
  signal?: AbortSignal;
  budget_ms_per_step?: number;
}

export async function previewWorkflow(
  params: PreviewWorkflowParams,
): Promise<PreviewWorkflowSummary> {
  const overallStart = Date.now();
  const scope: Record<string, unknown> = {};
  let lastStep: PreviewStepSummary | undefined;
  let ran = 0;

  for (const [index, step] of params.steps.entries()) {
    const summary = await previewStep({
      db: params.db,
      tenant_id: params.tenant_id,
      step,
      step_index: index,
      scope,
      workflow_input: params.workflow_input,
      ...(params.execution_mode ? { execution_mode: params.execution_mode } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.budget_ms_per_step !== undefined ? { budget_ms: params.budget_ms_per_step } : {}),
    });
    lastStep = summary;
    ran = index + 1;
    if (!summary.ok) {
      return {
        ok: false,
        steps_ran: ran,
        duration_ms: Date.now() - overallStart,
        stopped_at_step_id: step.id,
        classification: summary.classification,
        summary: `Workflow preview stopped at step \`${step.id}\`: ${summary.summary}`,
        last_step: summary,
      };
    }
    scope[step.id] = summary.output_preview;
  }
  return {
    ok: true,
    steps_ran: ran,
    duration_ms: Date.now() - overallStart,
    stopped_at_step_id: null,
    classification: "ok",
    summary:
      ran === 0
        ? "No steps to preview."
        : `Previewed ${ran} step${ran === 1 ? "" : "s"} with no errors.`,
    ...(lastStep ? { last_step: lastStep } : {}),
  };
}

// -------- internals --------

interface BuildPreviewContextParams {
  db: Db;
  tenant_id: string;
  step: StepDef;
  step_index: number;
  scope: Record<string, unknown>;
  signal: AbortSignal;
  execution_mode: ExecutionMode;
}

function buildPreviewContext(p: BuildPreviewContextParams): StepRunContext {
  const previewExecutionId = randomUUID();
  return {
    db: p.db,
    tenant_id: p.tenant_id,
    execution_id: previewExecutionId,
    workflow_id: `preview-${previewExecutionId}`,
    workflow_version_id: `preview-${previewExecutionId}`,
    workflow_slug: "preview",
    request_source: "chat",
    parent_execution_id: null,
    depth: 0,
    signal: p.signal,
    scope: p.scope,
    started_at: new Date(),
    trace_id: null,
    principal: null,
    execution_mode: p.execution_mode,
    step: p.step,
    step_index: p.step_index,
    // `step_row_id` is used only for offload references, which preview
    // bypasses; a synthetic id keeps any downstream logger field populated.
    step_row_id: `preview-step-${previewExecutionId}`,
  };
}

function summarizeStepResult(
  step: StepDef,
  result: StepResult,
  duration_ms: number,
): PreviewStepSummary {
  if (result.status === "succeeded") {
    return {
      ok: true,
      step_id: step.id,
      kind: step.kind,
      duration_ms,
      classification: "ok",
      summary: `Previewed step \`${step.id}\` (${step.kind}) in ${duration_ms}ms.`,
      output_preview: result.output,
    };
  }
  const classification = classifyFailure(result);
  const message = result.error?.message ?? "step failed";
  return {
    ok: false,
    step_id: step.id,
    kind: step.kind,
    duration_ms,
    classification,
    summary: humanizeClassification(classification, message, step.kind),
    ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
  };
}

function classifyFailure(result: StepResult): PreviewClassification {
  if (result.status === "aborted") return "aborted";
  if (result.status === "timed_out") return "timeout";
  const code = result.error?.code ?? "";
  const message = (result.error?.message ?? "").toLowerCase();
  if (code === "connector_not_found") return "connector_missing";
  if (code === "missing_graphql" || code === "unknown_step_kind") return "driver_error";
  if (code === "data_selector_error") return "schema_mismatch";
  if (/unresolved|placeholder/.test(message) || code === "placeholder_unresolved") {
    return "placeholder_unresolved";
  }
  if (/401|403|unauthori[sz]ed|forbidden|auth/i.test(message)) return "auth_failed";
  if (/timeout|timed out|exceeded/i.test(message)) return "timeout";
  if (/abort/i.test(message)) return "aborted";
  return "driver_error";
}

function humanizeClassification(
  classification: PreviewClassification,
  message: string,
  kind: string,
): string {
  switch (classification) {
    case "auth_failed":
      return `Authentication was rejected during the ${kind} preview — check the connector's credentials.`;
    case "placeholder_unresolved":
      return `A placeholder could not be resolved from scope: ${message}`;
    case "schema_mismatch":
      return `The step's data_selector did not match the response shape: ${message}`;
    case "timeout":
      return `The ${kind} preview exceeded its budget.`;
    case "aborted":
      return `The ${kind} preview was cancelled before completing.`;
    case "connector_missing":
      return `The connector referenced by this step is not available for preview.`;
    case "preview_unsupported":
      return `Preview is not yet supported for this step kind.`;
    case "driver_error":
      return `The step driver failed: ${message}`;
    default:
      return message || "Preview failed.";
  }
}
