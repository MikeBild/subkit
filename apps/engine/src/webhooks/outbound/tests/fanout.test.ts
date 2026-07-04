// Fan-out test. Seeds two subscriptions, one that matches
// `execution.*` and one that doesn't. Calls `fanoutEvent` with a
// synthetic `execution.succeeded`, then drains the webhook.deliver
// queue via `boss.fetch` and asserts exactly one job was enqueued and
// that it targets the matching subscription.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WEBHOOK_DELIVER_QUEUE, type WebhookDeliverJob } from "../delivery-worker.ts";
import { deterministicEventId, fanoutEvent } from "../fanout.ts";
import { createOutboundCtx, type OutboundTestCtx } from "./setup.ts";

let ctx: OutboundTestCtx;

beforeAll(async () => {
  ctx = await createOutboundCtx("fanout");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("outbound: fanout", () => {
  test("matching subscriptions receive a webhook.deliver job", async () => {
    const good = await ctx.createSub({
      event_pattern: "execution.*",
      target_url: "http://127.0.0.1:0/ignored",
      secret: "whsec_fanoutgoodaaaaaaaaaaaaaaaa",
    });
    await ctx.createSub({
      event_pattern: "workflow.updated",
      target_url: "http://127.0.0.1:0/ignored",
      secret: "whsec_fanoutbadaaaaaaaaaaaaaaaaa",
    });

    const stats = await fanoutEvent({
      db: ctx.db,
      boss: ctx.boss,
      tenant_id: ctx.tenantId,
      event_row_id: 9999,
      event_type: "execution.succeeded",
      payload: {
        execution_id: "00000000-0000-0000-0000-000000000010",
        workflow_id: "00000000-0000-0000-0000-000000000011",
        duration_ms: 42,
      },
    });
    expect(stats.matched).toBe(1);
    expect(stats.enqueued).toBe(1);

    // Drain one job from the queue and assert it targets the good sub.
    const jobs = await ctx.boss.fetch<WebhookDeliverJob>(WEBHOOK_DELIVER_QUEUE, {
      batchSize: 5,
    });
    expect(jobs?.length).toBe(1);
    const j = jobs?.[0];
    expect(j?.data.subscription_id).toBe(good.id);
    expect(j?.data.event_type).toBe("execution.succeeded");
    expect(j?.data.attempt_number).toBe(1);

    // Clean up: complete the fetched job so pg-boss teardown is happy.
    if (j) await ctx.boss.complete(WEBHOOK_DELIVER_QUEUE, j.id);
  });

  // #19: the delivery event_id is derived deterministically from the outbox
  // row id, so a retried event.fanout re-emits the SAME event_id — the
  // receiver/deliveries table can dedup, making fanout retries safe.
  test("deterministicEventId is stable + a valid v5 UUID", () => {
    const a = deterministicEventId(4242);
    const b = deterministicEventId(4242);
    const c = deterministicEventId(4243);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("re-fanning the same outbox row yields the same delivery event_id (retry-safe)", async () => {
    await ctx.createSub({
      event_pattern: "execution.*",
      target_url: "http://127.0.0.1:0/ignored",
      secret: "whsec_fanoutidemaaaaaaaaaaaaaaaa",
    });
    const fan = () =>
      fanoutEvent({
        db: ctx.db,
        boss: ctx.boss,
        tenant_id: ctx.tenantId,
        event_row_id: 4242,
        event_type: "execution.succeeded",
        payload: { execution_id: "00000000-0000-0000-0000-0000000000aa" },
      });

    await fan();
    await fan(); // simulate a retried event.fanout job for the same outbox row

    const jobs = await ctx.boss.fetch<WebhookDeliverJob>(WEBHOOK_DELIVER_QUEUE, { batchSize: 10 });
    const ids = (jobs ?? []).map((x) => x.data.event_id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    // Every re-emitted delivery carries the SAME, deterministic event_id.
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(deterministicEventId(4242));
    for (const x of jobs ?? []) await ctx.boss.complete(WEBHOOK_DELIVER_QUEUE, x.id);
  });
});
