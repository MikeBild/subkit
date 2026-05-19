// Chat-surface adapter for the unified tool dispatcher.
//
// Renders the dispatcher's ToolEnvelope into the conversation loop's
// existing ToolResult shape. Until sdk-wrap.ts cuts over, this adapter
// is wire-in-ready but unused at runtime — landing it here documents
// the integration point.

import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { dispatchTool } from "../../tools/dispatcher.ts";
import { conversationToolProvider, staticToolProvider } from "../../tools/index.ts";
import { buildRegistry, type ToolRegistry } from "../../tools/registry.ts";
import type { ToolEnvelope, ToolInvocation } from "../../tools/types.ts";
import type { PermissionMode } from "../tool-policies.ts";
import type { ToolContext, ToolResult } from "./index.ts";

let REGISTRY: ToolRegistry | null = null;
function unifiedRegistry(): ToolRegistry {
  if (!REGISTRY) {
    REGISTRY = buildRegistry([staticToolProvider, conversationToolProvider]);
  }
  return REGISTRY;
}

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
    // Render the ConfirmEnvelope as an ask_user_confirm pause — the
    // chat loop's existing elicitation machinery picks it up from here.
    return {
      ok: true,
      data: envelope.confirm,
      pause: {
        tool_name: "ask_user_confirm",
        kind: envelope.confirm.tool === "save_workflow_draft" ? "save_workflow_draft" : "generic",
        summary: envelope.confirm.resume,
        elicitation_id: envelope.confirm.tool_call_id,
        input: envelope.confirm.args,
      },
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
 *  place of its inline policy-resolve + execute dance. */
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
      registry: unifiedRegistry(),
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
