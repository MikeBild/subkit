// Outbox writer. Inserts into `events` inside the caller's transaction and
// issues a NOTIFY with the new event id. The listener lives in P4.

import { sql } from "drizzle-orm";
import { logger } from "../logging/logger.ts";
import type { Db } from "./client.ts";
import { events } from "./schema/events.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type OutboxChannel =
  | "execution.status"
  | "workflow.chain"
  | "workflow.lifecycle"
  | "connector.oauth"
  | "conversation.stream"
  | "event.emitted"
  | "notification.emitted";

/**
 * Insert a row into `events` and issue `pg_notify` with the new id.
 *
 * Must be called inside a caller-managed transaction so the domain write
 * and the outbox insert commit atomically. The NOTIFY payload is the
 * smallest possible envelope: just the event id as text.
 */
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

  // NOTIFY carries only the id — the listener catches up via
  // SELECT ... WHERE id > last_seen_id.
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
