import { sql } from "drizzle-orm";
import { logger } from "../logging/index.ts";
import type { Executor } from "./client.ts";
import { events } from "./schema/events.ts";

export type OutboxChannel =
  | "execution.status"
  | "workflow.chain"
  | "workflow.lifecycle"
  | "skill.lifecycle"
  | "connector.oauth"
  | "conversation.stream"
  | "event.emitted"
  | "notification.emitted"
  | "resource.lifecycle";

export async function writeEvent(
  tx: Executor,
  params: {
    tenant_id: string;
    channel: OutboxChannel;
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<number> {
  const [row] = await tx
    .insert(events)
    .values({
      tenant_id: params.tenant_id,
      channel: params.channel,
      type: params.type,
      payload: params.payload,
    })
    .returning({ id: events.id });

  if (!row) {
    throw new Error("writeEvent: insert returned no row");
  }

  await tx.execute(sql`SELECT pg_notify(${params.channel}, ${String(row.id)})`);

  logger.debug({
    module: "db",
    action: "event.written",
    msg: "outbox event written",
    tenant_id: params.tenant_id,
    channel: params.channel,
    event_type: params.type,
    event_id: row.id,
  });

  return row.id;
}
