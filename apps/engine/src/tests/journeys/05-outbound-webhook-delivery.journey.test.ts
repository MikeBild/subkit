// User story: As a platform operator, I want my subscribers to receive
// signed webhooks and for flaky subscribers to be circuit-broken, so
// that downstream outages never stall the outbox.
// Acceptance criteria:
//   - AC1: Creating a subscription and emitting a matching event drives
//          a signed POST to the subscriber.
//   - AC2: A failing receiver accumulates `consecutive_failures` and
//          opens the breaker after 10 failures.
//   - AC3: While the breaker is open, a subsequent delivery job writes a
//          `circuit_open` dead_letter row and skips the HTTP hit.
// Spec refs: docs/developers/input-surfaces.md

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";

import { deliveries, subscriptions } from "../../db/schema/index.ts";
import * as breaker from "../../webhooks/outbound/circuit-breaker.ts";
import {
  registerDeliveryWorker,
  type WebhookDeliverJob,
} from "../../webhooks/outbound/delivery-worker.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

interface MockRx {
  url: string;
  hits: Array<{ headers: Record<string, string>; body: string }>;
  behavior: (idx: number) => number;
  close: () => Promise<void>;
}

async function startMockRx(fail: number): Promise<MockRx> {
  const hits: Array<{ headers: Record<string, string>; body: string }> = [];
  const behavior = (idx: number): number => (idx < fail ? 500 : 200);
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(",");
      }
      hits.push({ headers, body: Buffer.concat(chunks).toString("utf8") });
      const code = behavior(hits.length - 1);
      res.statusCode = code;
      res.end(JSON.stringify({ ok: code < 400 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/hook`,
    hits,
    behavior,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let ctx: JourneyCtx;
let happyRx: MockRx;
let flakyRx: MockRx;

beforeAll(async () => {
  ctx = await createJourneyCtx("outbound-wh");
  happyRx = await startMockRx(0);
  flakyRx = await startMockRx(1_000);
  breaker.__resetAll();
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await happyRx.close();
  await flakyRx.close();
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: outbound webhook delivery", () => {
  test("AC1: signed POST lands at happy receiver and writes a success delivery row", async () => {
    const subRes = await journeyFetch(ctx, "/v1/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        event_pattern: "execution.succeeded",
        target_url: happyRx.url,
        secret: "whsec_happyaaaaaaaaaaaaaaaaaaaa",
      }),
    });
    expect(subRes.status).toBe(201);
    const sub = (await subRes.json()) as { id: string };

    // Drive the delivery handler inline for determinism.
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
      event_id: "00000000-0000-0000-0000-0000000000aa",
      event_type: "execution.succeeded",
      body: '{"type":"execution.succeeded","data":{"ok":true}}',
      webhook_id: "msg_journey5_happy",
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      timestamp: Math.floor(Date.now() / 1000),
      attempt_number: 1,
    };
    await handle({
      id: "j5-happy",
      name: "webhook.deliver",
      data: job,
    } as unknown as Job<WebhookDeliverJob>);

    expect(happyRx.hits.length).toBe(1);
    const hit = happyRx.hits[0]!;
    expect(hit.headers["webhook-id"]).toBe("msg_journey5_happy");
    expect(hit.headers["webhook-signature"]?.startsWith("v1,")).toBe(true);

    const rows = await ctx.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.tenant_id, ctx.tenantId), eq(deliveries.subscription_id, sub.id)));
    const success = rows.find((r) => r.status === "success");
    expect(success).toBeDefined();
    expect(success?.response_code).toBe(200);
  });

  test(
    "AC2: 10 failures open the circuit on the flaky subscription",
    async () => {
      const subRes = await journeyFetch(ctx, "/v1/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          event_pattern: "execution.failed",
          target_url: flakyRx.url,
          secret: "whsec_flakyaaaaaaaaaaaaaaaaaaaa",
        }),
      });
      const sub = (await subRes.json()) as { id: string };
      breaker.__resetAll();
      const { handle } = await registerDeliveryWorker({
        boss: ctx.boss,
        db: ctx.db,
        fetchImpl: fetch,
        jitter: false,
        noWork: true,
      });
      const before = flakyRx.hits.length;
      for (let i = 0; i < 10; i += 1) {
        const job: WebhookDeliverJob = {
          tenant_id: ctx.tenantId,
          subscription_id: sub.id,
          event_id: "00000000-0000-0000-0000-0000000000bb",
          event_type: "execution.failed",
          body: '{"type":"execution.failed"}',
          webhook_id: `msg_journey5_flaky_${i}`,
          // allow-wall-clock: this test exercises real-time polling or freshness windows.
          timestamp: Math.floor(Date.now() / 1000),
          attempt_number: 1,
        };
        await handle({
          id: `j5-flaky-${i}`,
          name: "webhook.deliver",
          data: job,
        } as unknown as Job<WebhookDeliverJob>);
      }
      expect(flakyRx.hits.length - before).toBe(10);
      expect(breaker.isOpen(sub.id)).toBe(true);

      const subRows = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
      expect(subRows[0]?.consecutive_failures).toBeGreaterThanOrEqual(10);
      expect(subRows[0]?.circuit_open_until).not.toBeNull();
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test("AC3: next delivery is short-circuited with circuit_open", async () => {
    const subRes = await journeyFetch(ctx, "/v1/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        event_pattern: "execution.aborted",
        target_url: flakyRx.url,
        secret: "whsec_shortcircuitaaaaaaaaaaaa",
      }),
    });
    const sub = (await subRes.json()) as { id: string };
    // Force the breaker open for THIS subscription.
    for (let i = 0; i < 10; i += 1) await breaker.recordFailure(ctx.db, sub.id);
    expect(breaker.isOpen(sub.id)).toBe(true);

    const { handle } = await registerDeliveryWorker({
      boss: ctx.boss,
      db: ctx.db,
      fetchImpl: fetch,
      jitter: false,
      noWork: true,
    });
    const before = flakyRx.hits.length;
    const job: WebhookDeliverJob = {
      tenant_id: ctx.tenantId,
      subscription_id: sub.id,
      event_id: "00000000-0000-0000-0000-0000000000cc",
      event_type: "execution.aborted",
      body: '{"type":"execution.aborted"}',
      webhook_id: "msg_journey5_circopen",
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      timestamp: Math.floor(Date.now() / 1000),
      attempt_number: 1,
    };
    await handle({
      id: "j5-circ",
      name: "webhook.deliver",
      data: job,
    } as unknown as Job<WebhookDeliverJob>);
    expect(flakyRx.hits.length).toBe(before);

    const rows = await ctx.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.subscription_id, sub.id));
    const dead = rows.find((r) => r.error === "circuit_open");
    expect(dead).toBeDefined();
    expect(dead?.status).toBe("dead_letter");
  });
});
