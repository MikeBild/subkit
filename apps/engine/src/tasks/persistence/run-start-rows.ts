import { and, eq, isNull, lt, ne, not, type SQL, sql } from "drizzle-orm";
import {
  conversations,
  type Db,
  type Executor,
  taskGrants,
  taskRuns,
  tasks,
} from "../../db/index.ts";

export function taskRunConversationPrepared(): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${conversations} prepared
     WHERE prepared.tenant_id = ${taskRuns.tenant_id}
       AND prepared.id = ${taskRuns.conversation_id}
       AND prepared.playbook_revision > 0)`;
}

export async function findOpenGrant(
  tx: Executor,
  task: Pick<typeof tasks.$inferSelect, "tenant_id" | "id" | "environment">,
): Promise<typeof taskGrants.$inferSelect | undefined> {
  const [grant] = await tx
    .select()
    .from(taskGrants)
    .where(
      and(
        eq(taskGrants.tenant_id, task.tenant_id),
        eq(taskGrants.task_id, task.id),
        eq(taskGrants.environment, task.environment),
        isNull(taskGrants.revoked_at),
      ),
    )
    .limit(1);
  return grant;
}

export async function markTaskClaimed(
  tx: Executor,
  task: { tenant_id: string; id: string },
  at: Date,
): Promise<void> {
  await tx
    .update(tasks)
    .set({ last_claimed_at: at })
    .where(and(eq(tasks.tenant_id, task.tenant_id), eq(tasks.id, task.id)));
}

export async function conversationLoadedSkills(
  db: Executor,
  scope: { tenant_id: string; conversation_id: string },
): Promise<Array<{ slug: string; last_turn: number }>> {
  const [row] = await db
    .select({ loaded_skills: conversations.loaded_skills })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, scope.tenant_id),
        eq(conversations.id, scope.conversation_id),
      ),
    )
    .limit(1);
  return row?.loaded_skills ?? [];
}

export async function conversationPlaybookRevision(
  tx: Executor,
  scope: { tenant_id: string; conversation_id: string | null },
): Promise<number | null> {
  if (!scope.conversation_id) return null;
  const [row] = await tx
    .select({ revision: conversations.playbook_revision })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, scope.tenant_id),
        eq(conversations.id, scope.conversation_id),
      ),
    )
    .limit(1);
  return row?.revision ?? null;
}

export async function openRunConversationIds(
  tx: Executor,
  run: { tenant_id: string; id: string },
): Promise<string[]> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, run.tenant_id),
        ne(conversations.status, "abandoned"),
        sql`${conversations.draft} -> 'session' -> 'task_run' ->> 'task_run_id' = ${run.id}`,
      ),
    );
  return rows.map((row) => row.id);
}

export async function unpreparedRunIds(
  db: Db,
  tenant_id: string,
  older_than: Date,
): Promise<string[]> {
  const rows = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.tenant_id, tenant_id),
        eq(taskRuns.state, "running"),
        lt(taskRuns.created_at, older_than),
        not(taskRunConversationPrepared()),
      ),
    )
    .orderBy(taskRuns.id);
  return rows.map((row) => row.id);
}
