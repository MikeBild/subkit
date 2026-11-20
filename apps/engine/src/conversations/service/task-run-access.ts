import { and, eq, isNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Executor } from "../../db/client.ts";
import {
  conversationElicitations,
  conversations,
  roles,
  systemAccounts,
  taskRuns,
  toolApprovals,
  users,
} from "../../db/schema/index.ts";
import { withContext } from "../../logging/context.ts";
import { hasBuiltinAdminRole } from "../../rbac/evaluator.ts";
import { getTaskRunMarker } from "../core/draft.ts";
import { approvalHandleFromElicitationInput } from "../tools/ask-user/commit-intent.ts";
import type { TaskRunMarker } from "../types.ts";
import {
  TaskRunApprovalForbiddenError,
  TaskRunPermissionModeError,
  TaskRunWriteForbiddenError,
} from "./task-run-errors.ts";
import { taskRunPrincipal } from "./task-run-marker.ts";

export {
  TaskRunApprovalForbiddenError,
  TaskRunApprovalUnavailableError,
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

export type TaskRunApprovalRefusal = "not_allowed" | "owner_or_admin";

async function linkedRunScopes(
  exec: Executor,
  p: { tenant_id: string; approval_id: string },
): Promise<{ linked: number; scopes: TaskRunScope[] }> {
  const linked = await exec
    .select({ conversation_id: conversationElicitations.conversation_id })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        sql`${conversationElicitations.input}->'commit_intent'->'payload'->>'approval_id' = ${p.approval_id}`,
      ),
    );
  const scopes: TaskRunScope[] = [];
  for (const row of linked) {
    const scope = await readTaskRunScope(exec, p.tenant_id, row.conversation_id);
    if (scope) scopes.push(scope);
  }
  return { linked: linked.length, scopes };
}

async function runTraceId(
  exec: Executor,
  tenant_id: string,
  task_run_id: string,
): Promise<string | null> {
  const [run] = await exec
    .select({ trace_id: taskRuns.trace_id })
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, task_run_id)))
    .limit(1);
  return run?.trace_id ?? null;
}

export async function taskRunApprovalTrace(
  exec: Executor,
  p: { tenant_id: string; approval_id: string },
): Promise<string | null> {
  const { scopes } = await linkedRunScopes(exec, p);
  const [scope] = scopes;
  return scope ? await runTraceId(exec, p.tenant_id, scope.marker.task_run_id) : null;
}

export async function inTaskRunApprovalTrace<T>(
  exec: Executor,
  p: { tenant_id: string; approval_id: string },
  work: () => Promise<T>,
): Promise<T> {
  const trace_id = await taskRunApprovalTrace(exec, p);
  return trace_id ? await withContext({ audit_trace_id: trace_id }, work) : await work();
}

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
  const { linked, scopes } = await linkedRunScopes(exec, p);
  if (linked === 0) {
    if (approval.surface !== "chat") return null;
    if (!p.user_id) return "not_allowed";
    return p.user_id === approval.principal_id ||
      (await isActiveAdmin(exec, p.tenant_id, p.user_id))
      ? null
      : "not_allowed";
  }
  for (const scope of scopes) {
    if (!p.user_id) return "owner_or_admin";
    if (scope.owner_id === p.user_id) continue;
    if (!(await isActiveAdmin(exec, p.tenant_id, p.user_id))) return "owner_or_admin";
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

export interface TaskRunApprovalDecider {
  approval_id: string;
  owner_id: string;
  decided_by_owner: boolean;
  trace_id: string | null;
}

export async function assertTaskRunApprovalDecider(
  exec: Executor,
  writer: TaskRunWriter,
  elicitation_input: unknown,
): Promise<TaskRunApprovalDecider | null> {
  const approval_id = approvalHandleFromElicitationInput(elicitation_input);
  if (!approval_id) return null;
  const scope = await readTaskRunScope(exec, writer.tenant_id, writer.conversation_id);
  if (!scope) return null;
  if (scope.owner_id === null || !(await mayWrite(exec, scope, writer)))
    throw new TaskRunApprovalForbiddenError();
  return {
    approval_id,
    owner_id: scope.owner_id,
    decided_by_owner: (writer.principal?.id ?? writer.actor_id) === scope.owner_id,
    trace_id: await runTraceId(exec, writer.tenant_id, scope.marker.task_run_id),
  };
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
