// `classifyPreviewFailure` — sort a failed dry-run into one of three
// buckets so the commit gate can react proportionally:
//
//   - `config_invalid`  the draft itself is broken (unresolved step
//     reference, JSONata parse error, cycle, validation failure). A
//     `force_commit` must NOT bypass this — committing would persist a
//     known-broken DAG.
//   - `runtime_data`    the draft is structurally sound but the upstream
//     world returned a data/permission error (404/410 on a deleted
//     record, 401/403 on a scope the operator hasn't granted yet, a 5xx
//     from the remote system). A successful build never records a
//     runtime `output_preview`; only a dry_run does. Forcing a clean
//     commit here is legitimate — the workflow is correct, the test
//     fixture was not.
//   - `unknown`         could not be classified. Treated as config
//     (block, safe) by the caller.
//
// Shared by the commit preview gate (commit-workflow.ts) and the
// transform-authoring gate (transform-authoring-gate.ts), so the two
// surfaces agree on what "the upstream step failed for a data reason"
// means.

import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";

export type PreviewFailureClass = "config_invalid" | "runtime_data" | "unknown";

/** HTTP statuses that mean "the remote world, not the draft, is the
 *  problem": resource gone/forbidden/unauthorized, or a server-side
 *  fault. */
function isRuntimeDataHttpStatus(status: number): boolean {
  return (
    status === 404 ||
    status === 410 ||
    status === 401 ||
    status === 403 ||
    (status >= 500 && status <= 599)
  );
}

/** Warning/error codes that signal a runtime/data failure rather than a
 *  malformed draft. Kept in one place so the commit gate and the
 *  transform gate share the same vocabulary. */
const RUNTIME_DATA_CODES: ReadonlySet<string> = new Set([
  "http_4xx",
  "http_404",
  "http_410",
  "permission_denied",
  "auth_failed",
]);

/** Codes that mean the draft is structurally wrong — `force_commit`
 *  must never bypass these. */
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
  // JSONata parse + generic validation error codes are config-invalid.
  // NB: deliberately NOT matching a bare "invalid" substring — runtime auth
  // failures surface codes like `invalid_credentials` / `invalid_token` (a
  // remote-world rejection that IS force-committable); catching those here
  // would wrongly block force_commit. Anything genuinely config-broken that
  // isn't an explicit code falls through to `unknown`, which the caller
  // already treats as block (safe), so nothing is under-blocked.
  return lower.includes("jsonata") || lower.includes("parse") || lower.includes("validation");
}

/** True when a single step trace failed for a runtime/data reason
 *  (HTTP status or error code). Reused by the transform-authoring gate
 *  to exempt a sibling step whose dry-run died on a 404/410/permission
 *  error. */
export function traceFailedWithRuntimeDataError(trace: WorkflowDraftStepPreview): boolean {
  if (trace.status !== "failed" && trace.status !== "error") return false;
  const rm = (trace.request_meta ?? null) as { status?: unknown } | null;
  if (rm && typeof rm.status === "number" && isRuntimeDataHttpStatus(rm.status)) return true;
  if (typeof trace.error_code === "string" && codeIsRuntimeData(trace.error_code)) return true;
  return false;
}

/**
 * Classify a failed preview. Inspects the failing step traces and the
 * preview-level warnings. A single config-invalid signal forces the
 * whole preview to `config_invalid` (block, safe); otherwise a
 * runtime/data signal yields `runtime_data`; absent both, `unknown`.
 */
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
