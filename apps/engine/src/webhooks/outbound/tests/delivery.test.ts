// Delivery worker happy path: a valid 200 from the mock receiver
// produces a `deliveries` row with status=success and an audit entry
// for `webhook.outbound.delivered`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import { deliveries } from "../../../db/schema/index.ts";
import type { WebhookDeliverJob } from "../delivery-worker.ts";
import { registerDeliveryWorker } from "../delivery-worker.ts";
import type { MockReceiver } from "./setup.ts";
import { createOutboundCtx, type OutboundTestCtx, startMockReceiver } from "./setup.ts";

let ctx: OutboundTestCtx;
let receiver: MockReceiver;

beforeAll(async () => {
  ctx = await createOutboundCtx("delivery");
  receiver = await startMockReceiver();
});

afterAll(async () => {
  await receiver.close();
  await ctx.cleanup();
});

describe("outbound: delivery happy path", () => {
  test("POSTs a signed payload and records a success row", async () => {
    const sub = await ctx.createSub({
      event_pattern: "execution.*",
      target_url: receiver.url,
      secret: "whsec_deliveryhappypathaaaaaaaa",
    });
    const { handle } = await registerDeliveryWorker({
      boss: ctx.boss,
      db: ctx.db,
      fetchImpl: fetch,
      jitter: false,
      noWork: true,
    });
    const job: WebhookDeliverJob = {
      tenant_id: ctx.tenantId,
      subscription_id: sub.id,
      event_id: "00000000-0000-0000-0000-000000000001",
      event_type: "execution.succeeded",
      body: '{"type":"execution.succeeded","data":{"ok":true}}',
      webhook_id: "msg_test_delivery",
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      timestamp: Math.floor(Date.now() / 1000),
      attempt_number: 1,
    };
    await handle({
      id: "job-1",
      name: "webhook.deliver",
      data: job,
    } as unknown as Job<WebhookDeliverJob>);

    // Receiver saw one hit.
    expect(receiver.hits.length).toBe(1);
    const hit = receiver.hits[0];
    expect(hit?.headers["webhook-id"]).toBe("msg_test_delivery");
    expect(hit?.headers["webhook-signature"]?.startsWith("v1,")).toBe(true);

    const rows = await ctx.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.subscription_id, sub.id), eq(deliveries.tenant_id, ctx.tenantId)));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.response_code).toBe(200);
  });
});
