// Chat-surface adapter for the unified tool dispatcher.
//
// Renders the dispatcher's ToolEnvelope into the conversation loop's
// existing ToolResult shape. Until sdk-wrap.ts cuts over, this adapter
// is wire-in-ready but unused at runtime — landing it here documents
// the integration point.

import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { dispatchTool } from "../../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolEnvelope, ToolInvocation } from "../../tools/types.ts";
import type { PermissionMode } from "../tool-policies.ts";
import type { ToolContext, ToolResult } from "./index.ts";

/** Convert a unified ToolEnvelope back to the legacy ToolResult shape
 *  the sdk-wrap invoke tail expects. The cutover replaces the inline
 *  execute() + policy gate dance with a call to this function. */
export function envelopeToToolResult(envelope: ToolEnvelope): ToolResult {
  if (envelope.status === "ok") {
    const out: ToolResult = { ok: true, data: envelope.data };
    if (envelope.pause) Object.assign(out, { pause: envelope.pause });
    if (envelope.committed_workflow_id) {
      Object.assign(out, { committed_workflow_id: envelope.committed_workflow_id });
    }
    return out;
  }
  if (envelope.status === "error") {
    const out: ToolResult = {
      ok: false,
      error_code: envelope.error_code,
      message: envelope.message,
    };
    if (envelope.details !== undefined) {
      Object.assign(out, { details: envelope.details });
    }
    if (envelope.next_best_actions) {
      Object.assign(out, { next_best_actions: [...envelope.next_best_actions] });
    }
    return out;
  }
  if (envelope.status === "needs_confirm") {
    // A chat pause is a persisted `conversation_elicitations` row, and this
    // renderer is pure — it has no db to insert one. Synthesising a pause here
    // would alias the approval's single-use `tool_call_id` into
    // `elicitation_id`, handing the model the trigger handle and pointing the
    // operator's answer at a row that does not exist. The cutover inserts the
    // elicitation first (see `sdk-wrap/invoke.ts`) and renders the pause from
    // that row's id; until then, say what happened and expose no handle.
    return {
      ok: false,
      error_code: "policy_confirm_required",
      message: `${envelope.confirm.tool} paused on a person's approval and nothing ran. No approval prompt was opened for it here.`,
      details: { tool: envelope.confirm.tool, reason: envelope.confirm.reason },
    };
  }
  if (envelope.status === "paused") {
    return { ok: true, data: null, pause: envelope.pause };
  }
  // not_available_on_surface — should not happen on chat surface in
  // normal flow (chat is the conversation surface). Return a structured
  // error so the loop can log it.
  return {
    ok: false,
    error_code: "not_available_on_surface",
    message: envelope.reason,
  };
}

/** Top-level chat invoke — sdk-wrap.ts cuts over to calling this in
 *  place of its inline policy-resolve + execute dance.
 *
 *  NOT WIRED TO PRODUCTION CHAT YET. The chat loop still owns
 *  rate-limiting, abort signals, live-log forwarding, and draft-state
 *  diff emission via `sdk-wrap.ts` — those concerns are loop-scoped,
 *  not surface-scoped, and are not present in this adapter. Do not
 *  call from production paths until the cutover lands and the loop
 *  features are either preserved here or proven unnecessary. Today
 *  this function is exercised only by unit + cross-surface parity
 *  tests to prove the wire-in is ready when the cutover happens. */
export async function invokeForSdk(opts: {
  db: Db;
  principal: ResolvedPrincipal;
  conversationCtx: ToolContext;
  permissionMode: PermissionMode | null;
  loadedSkills: ReadonlySet<string>;
  invocation: ToolInvocation;
}): Promise<ToolResult> {
  const envelope = await dispatchTool(
    {
      registry: getUnifiedRegistry(),
      db: opts.db,
      principal: opts.principal,
      conversationCtx: opts.conversationCtx,
      permissionMode: opts.permissionMode,
      loadedSkills: opts.loadedSkills,
    },
    opts.invocation,
  );
  return envelopeToToolResult(envelope);
}
