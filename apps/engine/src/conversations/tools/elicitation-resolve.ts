// Shared elicitation-resolve helpers.
//
// `resolveAndError` and `alreadyResolved` collapse the repeated
// "resolve a pending elicitation row → reactivate the conversation →
// return a structured-error `ToolResult`" sequence. They are consumed by
// BOTH the `ask_user_*` tool family (`ask-user/common.ts`) and
// `authenticate_oauth` (`authenticate-oauth.ts`) — `authenticate_oauth`
// is not an `ask_user_*` tool, so these helpers live in a neutral module
// rather than inside `ask-user/`.

import { resolveElicitationAndReactivate } from "../elicitations.ts";
import { ELICITATION_ALREADY_RESOLVED } from "./error-codes.ts";
import type { ToolContext, ToolResult } from "./index.ts";

// A bridge-path elicitation row that a concurrent `respondElicitation`
// resolved first (lost race). Do not re-apply the outcome or re-flip the
// conversation status — the winning path already did. Mirror how the
// DB-pause path reacts to the same `ResolveElicitationResult` kind, but
// expressed as a returned `ToolResult` (this layer returns, never throws).
export function alreadyResolved(elicitationId: string): ToolResult {
  return {
    ok: false,
    error_code: ELICITATION_ALREADY_RESOLVED,
    message:
      "This elicitation was already answered through another channel; re-read conversation state instead of retrying.",
    data: { status: "already_resolved", elicitation_id: elicitationId },
  };
}

/**
 * Resolve an elicitation row `cancelled` (decline / cancel / transport
 * failure), flip the owning conversation back to `active`, and return the
 * structured-error `ToolResult` the caller surfaces — all as one step.
 *
 * Collapses the repeated "resolve cancelled → reactivate → return
 * { ok: false }" sequence shared by the `ask_user_*` family and
 * `authenticate_oauth`. A lost race (a concurrent `respondElicitation`
 * resolved the row first) returns `alreadyResolved` instead — the winning
 * path already reactivated the conversation, so re-flipping would be wrong
 * and re-reporting the cancel reason would be misleading.
 *
 * `transport` is the bridge round-trip outcome — `"succeeded"` when the
 * elicitation was delivered and the operator answered (a decline still
 * means transport succeeded), `"failed"` when the round-trip itself broke.
 * It is recorded on the resolve audit row independently of the `cancelled`
 * resolution. Omit it for non-bridge (portal) resolutions.
 */
export async function resolveAndError(
  ctx: ToolContext,
  rowId: string,
  p: {
    reason: string;
    errorCode: string;
    message: string;
    transport?: "succeeded" | "failed";
    /** Persisted to the elicitation row's `output`. Defaults to `null`. */
    output?: unknown;
    /** Extra payload merged into the returned `data`. */
    data?: Record<string, unknown>;
    /** When set, written as `data.status` in the returned result. Omitted
     *  from `data` entirely when not passed — some callers carry no
     *  `status` key. */
    status?: string;
  },
): Promise<ToolResult> {
  const resolution = await resolveElicitationAndReactivate(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      id: rowId,
      output: p.output ?? null,
      decided_by: ctx.actor_id,
      status: "cancelled",
      reason: p.reason,
      ...(p.transport ? { transport: p.transport } : {}),
    },
    ctx.db,
  );
  if (resolution.kind !== "resolved") {
    return alreadyResolved(rowId);
  }
  return {
    ok: false,
    error_code: p.errorCode,
    message: p.message,
    data: {
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(p.data ?? {}),
    },
  };
}
