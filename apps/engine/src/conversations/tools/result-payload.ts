// Canonical ToolResult → persisted/model-visible payload projection.
//
// One implementation shared by the loop's per-tool wrapper
// (sdk-wrap/invoke.ts) and the direct user-driven invocation path
// (conversations/direct-invoke.ts), so a tool result persists and
// replays identically no matter which surface dispatched it. The
// error-shape breakers and the model both read this payload — a tool
// that sets its failure reason only at top-level (e.g.
// dry_run_workflow's needs-repair / judge-failed returns) must stay
// visible here on every surface.

import type { ToolResult } from "./index.ts";

/**
 * Persist the FULL output to the conversation_tool_calls row (for
 * audit / replay). For structured `ok: false` results that carry
 * `error_code` + `message` instead of `data`, build a normalised
 * output object so the model always sees a consistent envelope.
 * Data's own fields win on conflict (a tool that already nested
 * error_code in `data` keeps it).
 */
export function normalizeToolResultPayload(result: ToolResult): unknown {
  if (result.ok) return result.data;
  if (result.data !== undefined) {
    if (typeof result.data === "object" && result.data !== null) {
      return {
        ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.data as Record<string, unknown>),
      };
    }
    return result.data;
  }
  return {
    ok: false,
    ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.details !== undefined ? { details: result.details } : {}),
    ...(result.next_best_actions !== undefined
      ? { next_best_actions: result.next_best_actions }
      : {}),
  };
}
