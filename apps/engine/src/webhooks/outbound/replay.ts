import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction, audit } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { deliveries, events } from "../../db/schema/index.ts";
import { WEBHOOK_DELIVER_QUEUE, type WebhookDeliverJob } from "./delivery-worker.ts";

type ReplayActor = Pick<ResolvedPrincipal, "tenant_id" | "kind" | "id">;

interface ReplayDeliveryInput {
  subscription_id: string;
  delivery_id: string;
}

export async function replayDelivery(
  db: Db,
  boss: () => PgBoss,
  actor: ReplayActor,
  input: ReplayDeliveryInput,
): Promise<boolean> {
  const tenantId = actor.tenant_id;
  const { subscription_id: id, delivery_id } = input;
  const rows = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.tenant_id, tenantId),
        eq(deliveries.subscription_id, id),
        eq(deliveries.id, delivery_id),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return false;
  const queue = boss();

  const timestamp = Math.floor(Date.now() / 1000);
  let body: string;
  if (existing.outbox_event_id != null) {
    const outboxRows = await db
      .select()
      .from(events)
      .where(and(eq(events.tenant_id, tenantId), eq(events.id, existing.outbox_event_id)))
      .limit(1);
    const outbox = outboxRows[0];
    if (outbox) {
      body = JSON.stringify({
        type: outbox.type,
        timestamp,
        data: outbox.payload,
        replay: true,
        original_delivery_id: delivery_id,
      });
    } else {
      body = JSON.stringify({
        type: existing.event_type ?? "replay",
        timestamp,
        data: null,
        replay: true,
        original_delivery_id: delivery_id,
        note: "original outbox event unavailable",
      });
    }
  } else {
    body = JSON.stringify({
      type: existing.event_type ?? "replay",
      timestamp,
      data: null,
      replay: true,
      original_delivery_id: delivery_id,
    });
  }

  const job: WebhookDeliverJob = {
    tenant_id: tenantId,
    subscription_id: id,
    event_id: existing.event_id,
    event_type: existing.event_type ?? "replay",
    body,
    webhook_id: crypto.randomUUID(),
    timestamp,
    attempt_number: 1,
    outbox_event_id: existing.outbox_event_id ?? null,
  };
  await queue.send(WEBHOOK_DELIVER_QUEUE, job);
  audit(
    {
      tenant_id: tenantId,
      actor_type: actor.kind,
      actor_id: actor.id,
      action: AuditAction.WEBHOOK_OUTBOUND_REPLAYED,
      resource_type: "subscription",
      resource_id: id,
      result: "success",
      metadata: {
        delivery_id,
        outbox_event_id: existing.outbox_event_id ?? null,
        original_terminal_reason: existing.terminal_reason ?? null,
        original_classification: existing.classification ?? null,
      },
    },
    db,
  );
  return true;
}
