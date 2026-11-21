import { classifyErrorCode, ERROR_CAUSES } from "@shared/error-taxonomy.ts";
import {
  isReportMessageRefusal,
  reportRefusalReason,
} from "../../workflows/core/report-refusal.ts";
import type { StepDef } from "../../workflows/types.ts";
import type { RunResult, StepResult } from "../types.ts";

type ClassificationInput = Pick<StepResult, "status" | "error">;

export const CONNECTOR_DISABLED_CODE = "connector_disabled";

export const PREVIEW_CLASSIFICATIONS = ["ok", ...ERROR_CAUSES] as const;

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

function classifyStepResult(
  step: StepDef,
  result: ClassificationInput,
  duration_ms: number,
): PreviewStepSummary {
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
  const syntheticResult: ClassificationInput = {
    status:
      run.status === "timed_out" ? "timed_out" : run.status === "aborted" ? "aborted" : "failed",
    error: run.error ?? null,
  };
  return classifyStepResult(step, syntheticResult, duration_ms);
}

const TRANSIENT_RUN_CODES: ReadonlySet<string> = new Set([
  "connection",
  "http_5xx",
  "http_429",
  "graphql_throttle",
  "graphql_5xx",
]);

export function isTransientRunResult(run: RunResult): boolean {
  if (run.status === "timed_out") return false;
  const code = run.error?.code;
  return code != null && TRANSIENT_RUN_CODES.has(code);
}

export function classifyFailure(result: StepResult | ClassificationInput): PreviewClassification {
  if (result.status === "aborted") return "aborted";
  if (result.status === "skipped") return "aborted";
  if (result.status === "timed_out") return "timeout";
  const code = result.error?.code ?? "";
  const message = (result.error?.message ?? "").toLowerCase();
  if (
    code.startsWith("execution_authority_") &&
    isReportMessageRefusal(reportRefusalReason(result.error))
  )
    return "payload_invalid";
  const known = classifyErrorCode(code);
  if (known) return known.cause;
  return causeFromUnstructuredMessage(message);
}

function causeFromUnstructuredMessage(message: string): PreviewClassification {
  if (/rate limit/i.test(message)) return "rate_limited";
  if (/unresolved|placeholder/.test(message)) return "placeholder_unresolved";
  if (/401|403|unauthori[sz]ed|forbidden|\bauth\b|authenticat/i.test(message)) return "auth_failed";
  if (/timeout|timed out|exceeded/i.test(message)) return "timeout";
  if (/abort/i.test(message)) return "aborted";
  return "driver_error";
}

interface PersistedFailure {
  status: string;
  error: unknown;
}

export interface PersistedFailureClass {
  classification: PreviewClassification;
  error_code: string | null;
  message: string;
  guidance: string | null;
}

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
  const reason = typeof err.reason === "string" ? { reason: err.reason } : {};
  const recorded = PREVIEW_CLASSIFICATIONS.find(
    (known) => known !== "ok" && known === err.error_class,
  );
  const classification =
    recorded && status === "failed"
      ? recorded
      : classifyFailure({
          status,
          error: error_code ? { code: error_code, message, ...reason } : null,
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
    case "payload_invalid":
      return `The message the ${kind} step built is malformed and was not sent — fix how the step builds it; the approval still fits.`;
    case "preview_unsupported":
      return `This step kind cannot be run in isolation yet.`;
    case "driver_error":
      return `The step driver failed: ${message}`;
    case "incomplete_read":
      return `The ${kind} step stopped before every page was read, so its result would be incomplete: ${message}`;
    case "rate_limited":
      return `The vendor's rate limit stopped the ${kind} step; retry after the limit resets.`;
    default:
      return message || "Step failed.";
  }
}

export function classifyRunFailure(
  exec: Readonly<{
    status: string;
    failure: Readonly<{ error_code?: string | null; error_message?: string | null }> | null;
  }>,
  stopping: Readonly<{ status: string; error: unknown }> | null,
): PersistedFailureClass | null {
  if (stopping) return classifyPersistedFailure(stopping);
  if (exec.failure) {
    return classifyPersistedFailure({
      status: exec.status,
      error: { code: exec.failure.error_code, message: exec.failure.error_message },
    });
  }
  return null;
}
