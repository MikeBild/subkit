// Step-outcome classification taxonomy. Used by `dry_run_step` / `dry_run_workflow`
// conversation tools to render human-readable summaries when a step-run or
// draft-run fails, so the chat surface can show "auth_failed" / "schema_mismatch"
// instead of a raw stack trace.
//
// Unified entry point: `classifyRunResult(runResult, step?)` — callers pass the
// output of runExecution/runSingleStep plus the step def (if known) and get
// back a PreviewStepSummary-shaped envelope.

import type { StepDef } from "../workflows/types.ts";
import type { RunResult, StepResult } from "./types.ts";

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

export function classifyStepResult(
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
      summary: `Ran step \`${step.id}\` (${step.kind}) in ${duration_ms}ms.`,
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

/** Classify a full RunResult (saved / draft / step) into a PreviewStepSummary
 *  describing the last step. Used by `dry_run_step` when it runs a single
 *  step via `runSingleStep`. */
export function classifyRunResult(step: StepDef, run: RunResult): PreviewStepSummary {
  const last = run.steps[run.steps.length - 1];
  const duration_ms = last?.duration_ms ?? 0;
  if (run.status === "succeeded") {
    return {
      ok: true,
      step_id: step.id,
      kind: step.kind,
      duration_ms,
      classification: "ok",
      summary: `Ran step \`${step.id}\` (${step.kind}) in ${duration_ms}ms.`,
      output_preview: run.output,
    };
  }
  const syntheticResult: StepResult = {
    status:
      run.status === "timed_out" ? "timed_out" : run.status === "aborted" ? "aborted" : "failed",
    retry_count: last?.retry_count ?? 0,
    duration_ms,
    error: run.error ?? null,
  };
  return classifyStepResult(step, syntheticResult, duration_ms);
}

/** Transient upstream-failure codes a single-step run may surface on its
 *  top-level `RunResult.error.code`. These are the retryable transport /
 *  rate-limit / server-error classes the request and graphql drivers emit
 *  (HTTP: `connection`, `http_5xx`, `http_429`; GraphQL: `graphql_throttle`,
 *  `graphql_5xx`). Timeouts are deliberately NOT in this set — a step that
 *  blew its wall-clock budget surfaces `status: "timed_out"` / code
 *  `step_timeout`, which is a TERMINAL outcome (re-running the same slow
 *  request just re-spends the budget). */
const TRANSIENT_RUN_CODES: ReadonlySet<string> = new Set([
  "connection",
  "http_5xx",
  "http_429",
  "graphql_throttle",
  "graphql_5xx",
]);

/** True when a single-step `RunResult` failed with a transient upstream
 *  fault that a bounded retry could plausibly clear. The request/graphql
 *  drivers already retry most transients in-band; this predicate lets the
 *  authoring layer add a thin safety net around the residual flap so a
 *  flickering upstream doesn't trip `error_code_repeat_block`. Timeouts and
 *  every deterministic failure (auth, 4xx, placeholder, schema) return
 *  false — re-running them only repeats the same outcome. */
export function isTransientRunResult(run: RunResult): boolean {
  // A timed-out run is terminal by contract — never retry it here.
  if (run.status === "timed_out") return false;
  const code = run.error?.code;
  return code != null && TRANSIENT_RUN_CODES.has(code);
}

export function classifyFailure(result: StepResult): PreviewClassification {
  if (result.status === "aborted") return "aborted";
  if (result.status === "skipped") return "aborted";
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

export function humanizeClassification(
  classification: PreviewClassification,
  message: string,
  kind: string,
): string {
  switch (classification) {
    case "auth_failed":
      return `Authentication was rejected during the ${kind} step — check the connector's credentials.`;
    case "placeholder_unresolved":
      return `A placeholder could not be resolved from scope: ${message}`;
    case "schema_mismatch":
      return `The step's data_selector did not match the response shape: ${message}`;
    case "timeout":
      return `The ${kind} step exceeded its timeout.`;
    case "aborted":
      return `The ${kind} step was cancelled before completing.`;
    case "connector_missing":
      return `The connector referenced by this step is not available.`;
    case "preview_unsupported":
      return `This step kind cannot be run in isolation yet.`;
    case "driver_error":
      return `The step driver failed: ${message}`;
    default:
      return message || "Step failed.";
  }
}
