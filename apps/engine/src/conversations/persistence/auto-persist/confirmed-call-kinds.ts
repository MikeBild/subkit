import { parseMcpToolName } from "../../../connectors/drivers/mcp.ts";
import { approvalAuditResource, recordApprovalApproved } from "../../../tools/approval.ts";
import { noteApprovalForRuleOffer } from "../../approval-rules/offer.ts";
import { resolveAttachmentSlugsInArgs, walkAndResolve } from "../../attachments.ts";
import { relayGrantResult, usesDirectConnectorApproval } from "../../core/auto-persist.ts";
import { connectorIdsBySlug } from "../../service/resource-lookups.ts";
import { readTaskRunScope } from "../../service/task-run-access.ts";
import type { ToolResult } from "../../tools/index.ts";
import { checkToolPermission, resolveConversationPrincipal } from "../../tools/permission-gate.ts";
import {
  taskRunConnectorRefusal,
  taskRunToolRefusal,
} from "../../tools/sdk-wrap/task-run-guard.ts";
import type { TaskRunMarker } from "../../types.ts";
import { grantAndClaim, grantApprovalIfHuman } from "./approval.ts";
import { invalidIntent, principalRequired } from "./context.ts";
import type { CommitEnv } from "./types.ts";

export async function executeConfirmedToolCall(
  { p, ctx }: CommitEnv,
  gatedToolName: string | undefined,
  approvalId: string | undefined,
): Promise<ToolResult> {
  if (!gatedToolName || !approvalId) {
    return invalidIntent(
      "execute_confirmed_tool_call commit_intent is missing payload.tool or payload.approval_id — nothing ran.",
    );
  }
  const { getTool } = await import("../../tools/index.ts");
  const gatedTool = getTool(gatedToolName);
  if (!gatedTool) {
    return {
      ok: false,
      error_code: "unknown_tool",
      message: `no conversation tool named '${gatedToolName}' — nothing ran.`,
      data: {},
    };
  }
  const approver = p.principal ?? (await resolveConversationPrincipal(ctx));
  if (!approver) {
    return principalRequired(
      `releasing the approved ${gatedToolName} call needs the approving actor's principal for RBAC — nothing ran.`,
      {},
    );
  }
  const claim = await grantAndClaim(p, approvalId, gatedToolName, approver);
  if (!claim.ok) return { ok: false, error_code: claim.code, message: claim.message, data: {} };
  const taskRun = await readTaskRunScope(p.db, p.tenant_id, p.conversation_id);
  const outsideTask = taskRun
    ? await taskRunToolRefusal(gatedTool, taskRun.marker, ctx, claim.args)
    : null;
  if (outsideTask) return outsideTask;
  if (gatedTool.permission) {
    const perm = await checkToolPermission(
      ctx,
      gatedTool.permission,
      claim.args,
      approvalAuditResource(claim),
    );
    if (!perm.allow) {
      return (
        gatedTool.permission.denyResult?.(perm.permission, perm.reason) ?? {
          ok: false,
          error_code: "permission_denied",
          message: perm.reason,
          data: { permission: perm.permission },
        }
      );
    }
  }
  const recordedApproval = await recordApprovalApproved({
    db: p.db,
    principal: approver,
    claim,
    tool: gatedToolName,
    via: "chat",
  });
  if (!recordedApproval) {
    return {
      ok: false,
      error_code: "approval_audit_failed",
      message: `Approval ${claim.approval_id} could not be recorded in the audit log; ${gatedToolName} did not run. Re-issue it to obtain a fresh confirmation.`,
      data: {},
    };
  }
  const replayArgs = await walkAndResolve(
    await resolveAttachmentSlugsInArgs(claim.args, {
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      principal: approver,
    }),
    { db: p.db, tenant_id: p.tenant_id },
    new Map(),
  );
  const result = await gatedTool.execute(
    {
      ...ctx,
      principal: approver,
      ...(usesDirectConnectorApproval(claim.tool)
        ? {
            direct_connector_approval: {
              approval_id: claim.approval_id,
              surface: claim.surface,
              tool: claim.tool,
              binding: claim.direct_connector ?? null,
            },
          }
        : {}),
    },
    replayArgs,
  );
  if (result.ok) {
    await noteApprovalForRuleOffer({
      db: p.db,
      tenant_id: p.tenant_id,
      approver,
      answer_actor: p.answer_actor,
      unattended: taskRun !== null,
      tool: gatedToolName,
      args: claim.args,
      tool_call_id: p.elicitation.tool_call_id ?? null,
    });
  }
  return result;
}

async function relayedToolBound(
  p: CommitEnv["p"],
  marker: TaskRunMarker,
  relayedTool: string,
): Promise<boolean> {
  const slug = parseMcpToolName(relayedTool)?.slug;
  if (!slug || marker.sealed) return false;
  const ids = await connectorIdsBySlug(p.db, p.tenant_id, slug);
  return ids.length > 0 && ids.every((id) => marker.connector_ids.includes(id));
}

export async function grantRelayedToolCall(
  { p }: CommitEnv,
  relayedTool: string | undefined,
  approvalId: string | undefined,
): Promise<ToolResult> {
  if (!relayedTool || !approvalId) {
    return invalidIntent(
      "grant_relayed_tool_call commit_intent is missing payload.tool or payload.approval_id — nothing was granted.",
    );
  }
  const taskRun = await readTaskRunScope(p.db, p.tenant_id, p.conversation_id);
  if (taskRun && !(await relayedToolBound(p, taskRun.marker, relayedTool)))
    return taskRunConnectorRefusal();
  const relayGranted = await grantApprovalIfHuman({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    approval_id: approvalId,
    tool: relayedTool,
    actor: p.answer_actor,
  });
  return relayGrantResult(relayGranted, relayedTool);
}
