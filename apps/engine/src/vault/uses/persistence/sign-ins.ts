import { and, eq, gt, sql } from "drizzle-orm";
import { conversations, conversationToolCalls, type Executor } from "../../../db/index.ts";

export interface PendingSignIn {
  readonly tool_call_id: string;
  readonly conversation_id: string;
  readonly origin: string;
  readonly since: Date;
  readonly deadline: string | null;
}

export async function pendingSignIns(
  db: Executor,
  tenant_id: string,
  owner_id: string,
  now: Date,
): Promise<PendingSignIn[]> {
  const rows = await db
    .select({
      tool_call_id: conversationToolCalls.id,
      conversation_id: conversationToolCalls.conversation_id,
      origin: sql<
        string | null
      >`${conversationToolCalls.confirmation_data} -> 'device_pending' -> 'vault' ->> 'origin'`,
      deadline: sql<
        string | null
      >`${conversationToolCalls.confirmation_data} -> 'device' ->> 'deadline_at'`,
      since: conversationToolCalls.created_at,
    })
    .from(conversationToolCalls)
    .innerJoin(
      conversations,
      and(
        eq(conversations.tenant_id, conversationToolCalls.tenant_id),
        eq(conversations.id, conversationToolCalls.conversation_id),
      ),
    )
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversations.owner_id, owner_id),
        eq(conversationToolCalls.tool, "browser_sign_in"),
        eq(conversationToolCalls.outcome, "pending"),
        gt(conversationToolCalls.created_at, new Date(now.getTime() - 24 * 60 * 60_000)),
      ),
    )
    .limit(20);
  return rows.flatMap((row) =>
    row.origin === null || (row.deadline !== null && Date.parse(row.deadline) <= now.getTime())
      ? []
      : [
          {
            tool_call_id: row.tool_call_id,
            conversation_id: row.conversation_id,
            origin: row.origin,
            since: row.since,
            deadline: row.deadline,
          },
        ],
  );
}
