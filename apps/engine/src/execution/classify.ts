// Step-outcome classification taxonomy. Used by `dry_run_step` / `dry_run_workflow`
// conversation tools to render human-readable summaries when a step-run or
// draft-run fails, so the chat surface can show "auth_failed" / "schema_mismatch"
// instead of a raw stack trace.
//
// Unified entry point: `classifyRunResult(runResult, step?)` — callers pass the
// output of runExecution/runSingleStep plus the step def (if known) and get
// back a PreviewStepSummary-shaped envelope.

import type { StepDef } from "../workflows/types.ts";
import { CONNECTOR_DISABLED_CODE } from "./connector-availability.ts";
import type { RunResult, StepResult } from "./types.ts";

/** Every class, as a list — so a public schema can declare the enum without a second copy. */
export const PREVIEW_CLASSIFICATIONS = [
  "ok",
  "auth_failed",
  "placeholder_unresolved",
  "schema_mismatch",
  "timeout",
  "aborted",
  "connector_missing",
  // The workspace or the run reached its token ceiling. Kept apart from
  // `driver_error` because the remedy is a budget decision, not a repair: a
  // reader sent looking for a bug in a workflow that simply ran out of
  // allowance searches for something that is not there.
  "budget_exhausted",
  // A connector the run needs cannot serve it in the run's environment (lost
  // sign-in, no credential, switched off, absent): the engine refused the
  // run before its first step, or the step that would have called it. The
  // remedy is on the connector, never in the workflow or the external system.
  "connector_unavailable",
  // Closed before it ever ran — a preparation refused and stranded, later
  // failed by the engine. Nothing reached a step, so nothing failed in one.
  "refused_before_start",
  // The run's approval no longer covers what it would do (the workflow, its
  // targets or the approved bounds moved). A governance answer, not a
  // rejected sign-in: the remedy is to review the approval again.
  "authority_mismatch",
  "driver_error",
  "preview_unsupported",
  "unknown",
] as const;

export type PreviewClassification = (typeof PREVIEW_CLASSIFICATIONS)[number];

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
  // Exact codes before the message matchers: a refusal names its connector,
  // and a slug such as "auth0" or "oauth-crm" would otherwise read as a
  // rejected sign-in.
  if (code === "prepared_credential_unavailable" || code === CONNECTOR_DISABLED_CODE) {
    return "connector_unavailable";
  }
  if (code === "orphaned_preparation") return "refused_before_start";
  // "Execution authority could not be verified" contains "auth"; the message
  // matcher below would read it as a rejected sign-in.
  if (code.startsWith("execution_authority_")) return "authority_mismatch";
  // Before the generic matchers: "llm_quota_exhausted" carries the word
  // "exceeded" in its message and would otherwise be read as a timeout,
  // sending a reader to look at durations while the cause is money.
  if (code === "llm_quota_exhausted" || code === "llm_budget_exceeded") return "budget_exhausted";
  if (code === "missing_graphql" || code === "unknown_step_kind") return "driver_error";
  if (code === "data_selector_error") return "schema_mismatch";
  if (/unresolved|placeholder/.test(message) || code === "placeholder_unresolved") {
    return "placeholder_unresolved";
  }
  if (/401|403|unauthori[sz]ed|forbidden|\bauth\b|authenticat/i.test(message)) return "auth_failed";
  if (/timeout|timed out|exceeded/i.test(message)) return "timeout";
  if (/abort/i.test(message)) return "aborted";
  return "driver_error";
}

/** A failure as it was persisted: a step row's `status` + `error` jsonb, or
 *  the execution row's own `failure` (code + message, no step). */
export interface PersistedFailure {
  status: string;
  error: unknown;
}

export interface PersistedFailureClass {
  classification: PreviewClassification;
  error_code: string | null;
  message: string;
  /** Author- or driver-supplied remedy stored on the error, when present. */
  guidance: string | null;
}

/**
 * The one adapter from persisted rows to `classifyFailure`. The health digest
 * and the execution outcome both read failures back out of the database, and
 * both must classify the same row the same way.
 */
export function classifyPersistedFailure(failure: PersistedFailure): PersistedFailureClass {
  const err =
    failure.error && typeof failure.error === "object"
      ? (failure.error as Record<string, unknown>)
      : {};
  const error_code = typeof err.code === "string" ? err.code : null;
  const message = typeof err.message === "string" ? err.message : "";
  const guidance = typeof err.guidance === "string" ? err.guidance : null;
  const status =
    failure.status === "timed_out" || failure.status === "aborted" || failure.status === "skipped"
      ? failure.status
      : "failed";
  const classification = classifyFailure({
    status,
    retry_count: 0,
    duration_ms: 0,
    error: error_code ? { code: error_code, message } : null,
  });
  return { classification, error_code, message, guidance };
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
    case "budget_exhausted":
      return `The ${kind} step was refused because the token allowance is used up — raise the monthly cap or the run's own limit, or wait for the month to roll over.`;
    case "connector_missing":
      return `The connector referenced by this step is not available.`;
    case "connector_unavailable":
      return `A connector this run needs cannot serve it: ${message}`;
    case "refused_before_start":
      return `The run was refused before it started and never ran.`;
    case "authority_mismatch":
      return `The run's approval no longer matches what it would do — review the approval again.`;
    case "preview_unsupported":
      return `This step kind cannot be run in isolation yet.`;
    case "driver_error":
      return `The step driver failed: ${message}`;
    default:
      return message || "Step failed.";
  }
}
