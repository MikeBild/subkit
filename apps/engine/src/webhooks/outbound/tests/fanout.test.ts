// Fan-out test. Seeds two subscriptions, one that matches
// `execution.*` and one that doesn't. Calls `fanoutEvent` with a
// synthetic `execution.succeeded`, then drains the webhook.deliver
// queue via `boss.fetch` and asserts exactly one job was enqueued and
// that it targets the matching subscription.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WEBHOOK_DELIVER_QUEUE, type WebhookDeliverJob } from "../delivery-worker.ts";
import { fanoutEvent } from "../fanout.ts";
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
});
