import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  conversationElicitations,
  type Executor,
  taskRuns,
  tasks,
  tenants,
  toolApprovals,
  users,
  withTenantScope,
} from "../../../../db/index.ts";

export interface HeldTaskRun {
  task_id: string;
  task_name: string;
  approval: { id: string; tool: string } | null;
}

export async function heldTaskRun(
  db: Executor,
  tenant_id: string,
  task_run_id: string,
): Promise<HeldTaskRun | null> {
  const [run] = await db
    .select({
      task_id: taskRuns.task_id,
      task_name: tasks.name,
      conversation_id: taskRuns.conversation_id,
    })
    .from(taskRuns)
    .innerJoin(tasks, and(eq(tasks.id, taskRuns.task_id), eq(tasks.tenant_id, taskRuns.tenant_id)))
    .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, task_run_id)))
    .limit(1);
  if (!run) return null;
  const base = { task_id: run.task_id, task_name: run.task_name };
  if (!run.conversation_id) return { ...base, approval: null };
  const [pending] = await db
    .select({
      approval_id: sql<
        string | null
      >`${conversationElicitations.input}->'commit_intent'->'payload'->>'approval_id'`,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, run.conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at))
    .limit(1);
  const approvalId = pending?.approval_id;
  if (!approvalId || !/^[0-9a-f-]{36}$/.test(approvalId)) return { ...base, approval: null };
  const [approval] = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select({ id: toolApprovals.id, tool: toolApprovals.tool })
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.tenant_id, tenant_id),
          eq(toolApprovals.id, approvalId),
          isNull(toolApprovals.granted_at),
          isNull(toolApprovals.declined_at),
          isNull(toolApprovals.consumed_at),
          gt(toolApprovals.expires_at, sql`now()`),
        ),
      )
      .limit(1),
  );
  return { ...base, approval: approval ?? null };
}

export async function grantedByName(
  db: Executor,
  tenant_id: string,
  approval_id: string,
): Promise<string | null> {
  const [row] = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select({ email: users.email, display_name: users.display_name })
      .from(toolApprovals)
      .innerJoin(
        users,
        and(eq(users.id, toolApprovals.granted_by_user_id), eq(users.tenant_id, tenant_id)),
      )
      .where(and(eq(toolApprovals.tenant_id, tenant_id), eq(toolApprovals.id, approval_id)))
      .limit(1),
  );
  return row ? (row.display_name ?? row.email) : null;
}

export async function personName(
  db: Executor,
  tenant_id: string,
  user_id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email, display_name: users.display_name })
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), eq(users.id, user_id)))
    .limit(1);
  return row ? (row.display_name ?? row.email) : null;
}

export async function tenantLanguage(db: Executor, tenant_id: string): Promise<"de" | "en"> {
  const [row] = await db
    .select({ language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  return row?.language === "de" ? "de" : "en";
}
