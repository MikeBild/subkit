import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { roles, systemAccounts, toolApprovals, users } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { insertMcpTask, setMcpTaskFailure, setMcpTaskJobId } from "../mcp/tasks/store.ts";
import { enqueueConversationRunTurn } from "./handlers/conversation-run-turn.ts";

async function approvalOwnerPrincipal(
  tenant_id: string,
  approval_id: string,
  db: Db,
): Promise<ResolvedPrincipal | null> {
  const [owner] = await db
    .select({ principal_id: toolApprovals.principal_id })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, tenant_id), eq(toolApprovals.id, approval_id)))
    .limit(1);
  const id = owner?.principal_id;
  if (!id) return null;

  const [user] = await db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.id, id), eq(users.tenant_id, tenant_id)))
    .limit(1);
  if (user) {
    const roleNames = user.role_name ? [user.role_name] : [];
    return { provider: "conversation_tool", kind: "user", id, tenant_id, roles: roleNames };
  }

  const [account] = await db
    .select({ id: systemAccounts.id })
    .from(systemAccounts)
    .where(and(eq(systemAccounts.id, id), eq(systemAccounts.tenant_id, tenant_id)))
    .limit(1);
  if (account) {
    return { provider: "conversation_tool", kind: "system_account", id, tenant_id, roles: [] };
  }
  return null;
}

export async function enqueueApprovalElicitationResume(
  p: {
    tenant_id: string;
    conversation_id: string;
    elicitation_id: string;
    approval_id: string;
    approver_user_id: string | null;
    decision: "approve" | "decline";
  },
  db: Db,
  boss: PgBoss,
): Promise<boolean> {
  const runAs = await approvalOwnerPrincipal(p.tenant_id, p.approval_id, db);
  const actor_id = runAs?.kind === "user" ? runAs.id : p.approver_user_id;

  let task_id: string;
  try {
    task_id = await insertMcpTask(
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        kind: "respond_elicitation",
        actor_id,
        request_source: "portal",
        user_message_id: null,
      },
      db,
    );
  } catch (err) {
    logger.error({
      module: "queue",
      action: "approval_resume.task_insert_failed",
      msg: "could not mint the task row for a portal-decided approval resume",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation_id,
      ...errorFields(err),
    });
    return false;
  }

  try {
    const attempt_id = randomUUID();
    await setMcpTaskJobId(p.tenant_id, task_id, attempt_id, db);
    const job_id = await enqueueConversationRunTurn(
      boss,
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        mcp_task_id: task_id,
        actor_id,
        ...(runAs ? { principal: runAs } : {}),
        kind: "respond_elicitation",
        elicitation_id: p.elicitation_id,
        answer_channel: "portal",
        approver_user_id: p.approver_user_id,
        ...(p.decision === "decline" ? { reason: "user_declined" } : {}),
      },
      { id: attempt_id },
    );
    if (!job_id) {
      await setMcpTaskFailure(p.tenant_id, task_id, "enqueue_failed", db);
      return false;
    }
    if (job_id !== attempt_id) {
      await setMcpTaskFailure(p.tenant_id, task_id, "enqueue_id_mismatch", db);
      return false;
    }
    return true;
  } catch (err) {
    logger.error({
      module: "queue",
      action: "approval_resume.enqueue_failed",
      msg: "could not enqueue the conversation turn for a portal-decided approval",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation_id,
      ...errorFields(err),
    });
    await setMcpTaskFailure(p.tenant_id, task_id, "enqueue_failed", db).catch(() => {});
    return false;
  }
}
