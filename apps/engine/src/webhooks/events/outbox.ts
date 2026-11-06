import { and, asc, desc, eq, gt, type SQL, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction, audit } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { type OutboxChannel, writeEvent } from "../../db/events.ts";
import { events } from "../../db/schema/index.ts";
import { fanoutEvent } from "../outbound/fanout.ts";

export type OutboxEventRow = typeof events.$inferSelect;

export interface OutboxFilter {
  channel?: string | null | undefined;
  type?: string | null | undefined;
}

export interface OutboxStreamFilter extends OutboxFilter {
  execution_id?: string | null | undefined;
}

export interface EmitOutboxEventInput {
  type: string;
  payload: Record<string, unknown>;
  channel: OutboxChannel;
}

export type OutboxActor = Pick<ResolvedPrincipal, "tenant_id" | "kind" | "id">;

export function outboxTenantConds(tenantId: string, filter: OutboxStreamFilter): SQL[] {
  const tenantConds = [eq(events.tenant_id, tenantId)];
  if (filter.execution_id) {
    tenantConds.push(sql`${events.payload}->>'execution_id' = ${filter.execution_id}`);
  }
  if (filter.channel) tenantConds.push(eq(events.channel, filter.channel));
  if (filter.type) tenantConds.push(eq(events.type, filter.type));
  return tenantConds;
}

export async function listOutboxEvents(
  db: Db,
  tenantId: string,
  filter: OutboxFilter,
  limit: number,
): Promise<OutboxEventRow[]> {
  return db
    .select()
    .from(events)
    .where(and(...outboxTenantConds(tenantId, filter)))
    .orderBy(desc(events.id))
    .limit(limit);
}

export async function emitOutboxEvent(
  db: Db,
  boss: () => PgBoss,
  actor: OutboxActor,
  input: EmitOutboxEventInput,
): Promise<number> {
  const event_id = await db.transaction(async (tx) => {
    return await writeEvent(tx, {
      tenant_id: actor.tenant_id,
      channel: input.channel,
      type: input.type,
      payload: input.payload,
    });
  });
  audit(
    {
      tenant_id: actor.tenant_id,
      actor_type: actor.kind,
      actor_id: actor.id,
      action: AuditAction.EVENT_EMITTED,
      resource_type: "event",
      resource_id: String(event_id),
      result: "success",
      metadata: { type: input.type, channel: input.channel },
    },
    db,
  );
  try {
    await fanoutEvent({
      db,
      boss: boss(),
      tenant_id: actor.tenant_id,
      event_row_id: event_id,
      event_type: input.type,
      payload: input.payload,
    });
  } catch {}
  return event_id;
}

export async function readOutboxAfter(
  db: Db,
  conds: SQL[],
  afterId: number,
  limit: number,
): Promise<OutboxEventRow[]> {
  return db
    .select()
    .from(events) // tenant-filter:exempt — conds always includes the caller-supplied tenant predicate
    .where(and(...conds, gt(events.id, afterId)))
    .orderBy(asc(events.id))
    .limit(limit);
}

export async function readOutboxNewestId(db: Db, conds: SQL[]): Promise<number | null> {
  const [newest] = await db
    .select({ id: events.id })
    .from(events) // tenant-filter:exempt — conds always includes the caller-supplied tenant predicate
    .where(and(...conds))
    .orderBy(desc(events.id))
    .limit(1);
  return newest?.id ?? null;
}

export async function readOutboxOldest(
  db: Db,
  conds: SQL[],
  limit: number,
): Promise<OutboxEventRow[]> {
  return db
    .select()
    .from(events) // tenant-filter:exempt — conds always includes the caller-supplied tenant predicate
    .where(and(...conds))
    .orderBy(asc(events.id))
    .limit(limit);
}

export async function readOutboxNewest(
  db: Db,
  conds: SQL[],
  limit: number,
): Promise<OutboxEventRow[]> {
  return db
    .select()
    .from(events) // tenant-filter:exempt — conds always includes the caller-supplied tenant predicate
    .where(and(...conds))
    .orderBy(desc(events.id))
    .limit(limit);
}
