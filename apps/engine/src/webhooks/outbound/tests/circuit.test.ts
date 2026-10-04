import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import { deliveries, subscriptions } from "../../../db/schema/index.ts";
import * as breaker from "../circuit-breaker.ts";
import type { WebhookDeliverJob } from "../delivery-worker.ts";
import { registerDeliveryWorker } from "../delivery-worker.ts";
import type { MockReceiver } from "./setup.ts";
import { createOutboundCtx, type OutboundTestCtx, startMockReceiver } from "./setup.ts";

let ctx: OutboundTestCtx;
let receiver: MockReceiver;

beforeAll(async () => {
  ctx = await createOutboundCtx("circuit");
  receiver = await startMockReceiver({ failTimes: 1_000, statusWhenFailing: 500 });
});

afterAll(async () => {
  await receiver.close();
  await ctx.cleanup();
});

describe("outbound: circuit breaker", () => {
  test("opens after 10 consecutive failures and short-circuits the 11th", async () => {
    const sub = await ctx.createSub({
      event_pattern: "execution.*",
      target_url: receiver.url,
      secret: "whsec_circuitaaaaaaaaaaaaaaaaaa",
    });
    breaker.__resetAll();
    const { handle } = await registerDeliveryWorker({
      boss: ctx.boss,
      db: ctx.db,
      fetchImpl: fetch,
      jitter: false,
      noWork: true,
    });

    const body = '{"type":"execution.succeeded"}';
    const hitsAtStart = receiver.hits.length;
    for (let i = 0; i < 10; i += 1) {
      const job: WebhookDeliverJob = {
        tenant_id: ctx.tenantId,
        subscription_id: sub.id,
        event_id: "00000000-0000-0000-0000-000000000003",
        event_type: "execution.succeeded",
        body,
        webhook_id: `msg_circ_${i}`,
        // allow-wall-clock: this test exercises real-time polling or freshness windows.
        timestamp: Math.floor(Date.now() / 1000),
        attempt_number: 1,
      };
      await handle({
        id: `c-${i}`,
        name: "webhook.deliver",
        data: job,
      } as unknown as Job<WebhookDeliverJob>);
    }
    expect(receiver.hits.length - hitsAtStart).toBe(10);

    expect(breaker.isOpen(sub.id)).toBe(true);
    const subRows = await ctx.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sub.id))
      .limit(1);
    expect(subRows[0]?.consecutive_failures).toBeGreaterThanOrEqual(10);
    expect(subRows[0]?.circuit_open_until).not.toBeNull();

    const hitsBefore11 = receiver.hits.length;
    const job11: WebhookDeliverJob = {
      tenant_id: ctx.tenantId,
      subscription_id: sub.id,
      event_id: "00000000-0000-0000-0000-000000000004",
      event_type: "execution.succeeded",
      body,
      webhook_id: "msg_circ_11",
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      timestamp: Math.floor(Date.now() / 1000),
      attempt_number: 1,
    };
    await handle({
      id: "c-11",
      name: "webhook.deliver",
      data: job11,
    } as unknown as Job<WebhookDeliverJob>);
    expect(receiver.hits.length).toBe(hitsBefore11);

    const deadRows = await ctx.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.subscription_id, sub.id));
    const dead = deadRows.find((r) => r.error === "circuit_open");
    expect(dead).toBeDefined();
    expect(dead?.status).toBe("dead_letter");
  }, 30_000);
});
