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

/**
 * How a tool call ended. Same four values the Prometheus
 * `conversation_tool_calls_total` counter labels with
 * (`recordConversationToolCall`), so one word means the same thing on a
 * dashboard and on a persisted `conversation_tool_calls.outcome`.
 */
export type ToolCallOutcome = "ok" | "error" | "denied" | "pending";

/**
 * Error codes that mean "a policy or permission refused this", as opposed
 * to "the tool ran and failed". Each is emitted by a refusal path in this
 * repo: `permission_denied` by the RBAC gate's default envelope and by the
 * `denyResult` of `call_connector` / `request_connector_reauth` (the RBAC
 * evaluator's reason form is `permission_denied:<permission>`);
 * `policy_confirm_required` and `not_available_on_surface` by the palette
 * dispatcher's chat renderer.
 */
const DENIAL_CODES = ["permission_denied", "policy_confirm_required", "not_available_on_surface"];

function isDenialCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return DENIAL_CODES.some((code) => value === code || value.startsWith(`${code}:`));
}

/**
 * Classify a `ToolResult` into the persisted outcome vocabulary. The
 * failure branch of `ToolResult` makes every distinguishing field optional,
 * so this discriminator has to be computed while the result is still in
 * hand — `normalizeToolResultPayload`'s output cannot be re-read for it.
 */
export function toolCallOutcome(result: ToolResult): ToolCallOutcome {
  // A pause means the turn stopped on a human decision that has not
  // happened yet — pending regardless of the `ok` flag the pausing tool
  // used to halt the loop.
  if (result.pause !== undefined) return "pending";
  if (result.ok) return "ok";
  if (isDenialCode(result.error_code)) return "denied";
  const data = result.data;
  if (typeof data === "object" && data !== null) {
    const rec = data as Record<string, unknown>;
    if (rec.denied === true) return "denied";
    if (isDenialCode(rec.error_code)) return "denied";
    if (isDenialCode(rec.error)) return "denied";
    const nested = rec.error;
    if (typeof nested === "object" && nested !== null) {
      if (isDenialCode((nested as Record<string, unknown>).code)) return "denied";
    }
  }
  return "error";
}
