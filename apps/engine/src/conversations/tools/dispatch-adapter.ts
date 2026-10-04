import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { dispatchTool } from "../../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolEnvelope, ToolInvocation } from "../../tools/types.ts";
import type { PermissionMode } from "../tool-policies.ts";
import type { ToolContext, ToolResult } from "./index.ts";

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
  return {
    ok: false,
    error_code: "not_available_on_surface",
    message: envelope.reason,
  };
}

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
