import { and, eq, isNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Executor } from "../../db/client.ts";
import {
  conversationElicitations,
  conversations,
  roles,
  systemAccounts,
  toolApprovals,
  users,
} from "../../db/schema/index.ts";
import { hasBuiltinAdminRole } from "../../rbac/evaluator.ts";
import { getTaskRunMarker } from "../core/draft.ts";
import { approvalHandleFromElicitationInput } from "../tools/ask-user/commit-intent.ts";
import type { TaskRunMarker } from "../types.ts";
import {
  TaskRunApprovalOwnerOnlyError,
  TaskRunPermissionModeError,
  TaskRunWriteForbiddenError,
} from "./task-run-errors.ts";
import { taskRunPrincipal } from "./task-run-marker.ts";

export {
  TaskRunApprovalOwnerOnlyError,
  TaskRunLockedError,
  TaskRunPermissionModeError,
  TaskRunWriteForbiddenError,
} from "./task-run-errors.ts";

export interface TaskRunWriter {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null | undefined;
}

export interface TaskRunScope {
  marker: TaskRunMarker;
  owner_id: string | null;
}

export async function readTaskRunScope(
  exec: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<TaskRunScope | null> {
  const [row] = await exec
    .select({ draft: conversations.draft, owner_id: conversations.owner_id })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  const marker = getTaskRunMarker(row?.draft);
  return marker ? { marker, owner_id: row?.owner_id ?? null } : null;
}

async function mayWrite(
  exec: Executor,
  scope: TaskRunScope,
  writer: TaskRunWriter,
): Promise<boolean> {
  const actor = writer.principal?.id ?? writer.actor_id;
  if (!actor) return false;
  if (writer.principal && writer.principal.tenant_id !== writer.tenant_id) return false;
  if (scope.owner_id !== null && actor === scope.owner_id) return true;
  if (writer.principal) return hasBuiltinAdminRole(writer.principal);
  return isActiveAdmin(exec, writer.tenant_id, actor);
}

async function isActiveAdmin(exec: Executor, tenant_id: string, actor: string): Promise<boolean> {
  const [person] = await exec
    .select({ role: roles.name })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .where(
      and(
        eq(users.tenant_id, tenant_id),
        eq(users.id, actor),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  if (person) return person.role === "admin";
  const [machine] = await exec
    .select({ role: roles.name })
    .from(systemAccounts)
    .innerJoin(roles, eq(roles.id, systemAccounts.role_id))
    .where(
      and(
        eq(systemAccounts.tenant_id, tenant_id),
        eq(systemAccounts.id, actor),
        isNull(systemAccounts.deleted_at),
      ),
    )
    .limit(1);
  return machine?.role === "admin";
}

export async function assertTaskRunTurn(
  exec: Executor,
  writer: TaskRunWriter & { permission_mode?: unknown },
): Promise<TaskRunMarker | null> {
  const marker = await assertTaskRunWriter(exec, writer);
  assertTaskRunPermissionMode(marker, writer.permission_mode);
  return marker;
}

export async function canWriteTaskRun(exec: Executor, writer: TaskRunWriter): Promise<boolean> {
  const scope = await readTaskRunScope(exec, writer.tenant_id, writer.conversation_id);
  return scope === null || mayWrite(exec, scope, writer);
}

export type TaskRunApprovalRefusal = "not_allowed" | "owner_only";

export async function taskRunApprovalRefusal(
  exec: Executor,
  p: { tenant_id: string; approval_id: string; user_id: string | null },
): Promise<TaskRunApprovalRefusal | null> {
  const [approval] = await exec
    .select({ principal_id: toolApprovals.principal_id, surface: toolApprovals.surface })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, p.tenant_id), eq(toolApprovals.id, p.approval_id)))
    .limit(1);
  if (!approval) return "not_allowed";
  const linked = await exec
    .select({ conversation_id: conversationElicitations.conversation_id })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        sql`${conversationElicitations.input}->'commit_intent'->'payload'->>'approval_id' = ${p.approval_id}`,
      ),
    );
  if (linked.length === 0) {
    if (approval.surface !== "chat") return null;
    if (!p.user_id) return "not_allowed";
    return p.user_id === approval.principal_id ||
      (await isActiveAdmin(exec, p.tenant_id, p.user_id))
      ? null
      : "not_allowed";
  }
  for (const row of linked) {
    const scope = await readTaskRunScope(exec, p.tenant_id, row.conversation_id);
    if (!scope) continue;
    if (!p.user_id || scope.owner_id !== p.user_id) return "owner_only";
  }
  return null;
}

export async function mayDecideTaskRunApproval(
  exec: Executor,
  p: { tenant_id: string; approval_id: string; user_id: string | null },
): Promise<boolean> {
  return (await taskRunApprovalRefusal(exec, p)) === null;
}

export async function assertTaskRunWriter(
  exec: Executor,
  writer: TaskRunWriter,
): Promise<TaskRunMarker | null> {
  const scope = await readTaskRunScope(exec, writer.tenant_id, writer.conversation_id);
  if (!scope) return null;
  if (!(await mayWrite(exec, scope, writer))) throw new TaskRunWriteForbiddenError();
  return scope.marker;
}

export async function assertTaskRunApprovalDecider(
  exec: Executor,
  writer: TaskRunWriter,
  elicitation_input: unknown,
): Promise<void> {
  if (!approvalHandleFromElicitationInput(elicitation_input)) return;
  const scope = await readTaskRunScope(exec, writer.tenant_id, writer.conversation_id);
  if (!scope) return;
  const actor = writer.principal?.id ?? writer.actor_id;
  if (scope.owner_id === null || actor !== scope.owner_id)
    throw new TaskRunApprovalOwnerOnlyError();
}

export function assertTaskRunPermissionMode(marker: TaskRunMarker | null, mode: unknown): void {
  if (marker && mode === "yolo") throw new TaskRunPermissionModeError();
}

export function requireTaskRunPrincipal(
  principal: ResolvedPrincipal | null | undefined,
  marker: TaskRunMarker,
): ResolvedPrincipal {
  if (!principal) throw new TaskRunWriteForbiddenError();
  return taskRunPrincipal(principal, marker);
}
