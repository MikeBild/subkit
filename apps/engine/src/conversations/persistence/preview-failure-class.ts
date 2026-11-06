import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";

type PreviewFailureClass = "config_invalid" | "runtime_data" | "unknown";

function isRuntimeDataHttpStatus(status: number): boolean {
  return status === 404 || status === 410 || (status >= 500 && status <= 599);
}

const RUNTIME_DATA_CODES: ReadonlySet<string> = new Set(["http_404", "http_410"]);

const CONFIG_INVALID_CODES: ReadonlySet<string> = new Set([
  "unresolved_identifier",
  "workflow_unresolved_step_reference",
  "workflow_cycle_detected",
]);

function codeIsRuntimeData(code: string): boolean {
  return RUNTIME_DATA_CODES.has(code);
}

function codeIsConfigInvalid(code: string): boolean {
  if (CONFIG_INVALID_CODES.has(code)) return true;
  const lower = code.toLowerCase();
  return lower.includes("jsonata") || lower.includes("parse") || lower.includes("validation");
}

export function traceFailedWithRuntimeDataError(trace: WorkflowDraftStepPreview): boolean {
  if (trace.status !== "failed" && trace.status !== "error") return false;
  const rm = (trace.request_meta ?? null) as { status?: unknown } | null;
  if (rm && typeof rm.status === "number" && isRuntimeDataHttpStatus(rm.status)) return true;
  if (typeof trace.error_code === "string" && codeIsRuntimeData(trace.error_code)) return true;
  return false;
}

export function classifyPreviewFailure(
  latestPreview: DraftDocument["latest_preview"],
): PreviewFailureClass {
  if (!latestPreview) return "unknown";

  const traces: WorkflowDraftStepPreview[] = Array.isArray(latestPreview.step_traces)
    ? latestPreview.step_traces
    : [];

  let sawRuntimeData = false;

  for (const trace of traces) {
    if (typeof trace.error_code === "string" && codeIsConfigInvalid(trace.error_code)) {
      return "config_invalid";
    }
    if (traceFailedWithRuntimeDataError(trace)) sawRuntimeData = true;
  }

  for (const warning of latestPreview.warnings ?? []) {
    const code = typeof warning.code === "string" ? warning.code : null;
    if (!code) continue;
    if (codeIsConfigInvalid(code)) return "config_invalid";
    if (codeIsRuntimeData(code)) sawRuntimeData = true;
  }

  return sawRuntimeData ? "runtime_data" : "unknown";
}
