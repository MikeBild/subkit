import { type LocalConfirmation, localConfirmationOf } from "@shared/device/confirmation.ts";
import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { conversations, conversationToolCalls } from "../db/schema/index.ts";

export interface PendingConfirmation {
  readonly confirmation_id: string;
  readonly conversation_id: string;
  readonly confirmation: LocalConfirmation;
}

export async function pendingDeviceConfirmations(
  exec: Executor,
  input: { tenant_id: string; device_id: string; owner_id: string },
): Promise<PendingConfirmation[]> {
  const rows = await exec
    .select({
      id: conversationToolCalls.id,
      conversation_id: conversationToolCalls.conversation_id,
      data: conversationToolCalls.confirmation_data,
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
        eq(conversationToolCalls.tenant_id, input.tenant_id),
        eq(conversationToolCalls.confirmation_state, "proposed"),
        eq(conversations.owner_id, input.owner_id),
        sql`${conversationToolCalls.confirmation_data} -> 'device' ->> 'device_id' = ${input.device_id}`,
      ),
    )
    .limit(20);
  return rows.flatMap((row) => {
    const confirmation = localConfirmationOf(row.data);
    return confirmation
      ? [{ confirmation_id: row.id, conversation_id: row.conversation_id, confirmation }]
      : [];
  });
}
