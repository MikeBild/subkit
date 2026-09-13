// Retry ladder tests.
//
// Three layers:
//
//   1. Unit-test `nextDelayMs` / `DEFAULT_RETRY_DELAYS_MS` so the
//      exact cadence table is asserted.
//   2. Integration-test #1 (success): drive the delivery handler
//      against a mock receiver that 503s for the first 3 attempts and
//      then returns 200. With the ladder shrunk to `[5, 5, 5]` the
//      worker should walk through 4 attempts total and the final
//      `deliveries` row should be `status: success`.
//   3. Integration-test #2 (exhaustion): with the ladder shrunk to
//      `[1, 1]` and a receiver that always 500s the worker should
//      record a `dead_letter` row on the third attempt.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import type { Job } from "pg-boss";

import { deliveries } from "../../../db/schema/index.ts";
import type { WebhookDeliverJob } from "../delivery-worker.ts";
import { registerDeliveryWorker } from "../delivery-worker.ts";
import { DEFAULT_RETRY_DELAYS_MS, nextDelayMs, RETRY_DELAYS_MS, setRetryDelays } from "../retry.ts";
import type { MockReceiver } from "./setup.ts";
import { createOutboundCtx, type OutboundTestCtx, startMockReceiver } from "./setup.ts";

describe("outbound: retry ladder (unit)", () => {
  test("DEFAULT_RETRY_DELAYS_MS matches the documented cadence", () => {
    const EXPECTED = [
      60_000,
      5 * 60_000,
      30 * 60_000,
      2 * 60 * 60_000,
      5 * 60 * 60_000,
      10 * 60 * 60_000,
      12 * 60 * 60_000,
      12 * 60 * 60_000,
      12 * 60 * 60_000,
      12 * 60 * 60_000,
      12 * 60 * 60_000,
    ];
    expect([...DEFAULT_RETRY_DELAYS_MS]).toEqual(EXPECTED);
    // The exported proxy alias should mirror the same values when the
    // active ladder hasn't been overridden.
    expect([...RETRY_DELAYS_MS]).toEqual(EXPECTED);
  });

  test("nextDelayMs walks the ladder and returns null after the tail", () => {
    setRetryDelays(null);
    for (let i = 0; i < DEFAULT_RETRY_DELAYS_MS.length; i += 1) {
      expect(nextDelayMs(i + 1, { jitter: false })).toBe(DEFAULT_RETRY_DELAYS_MS[i] ?? 0);
    }
    // attemptNumber past the ladder length => null (nothing left)
    expect(nextDelayMs(DEFAULT_RETRY_DELAYS_MS.length + 1, { jitter: false })).toBeNull();
  });

  test("setRetryDelays swaps the active ladder", () => {
    setRetryDelays([7, 11]);
    expect(nextDelayMs(1, { jitter: false })).toBe(7);
    expect(nextDelayMs(2, { jitter: false })).toBe(11);
    expect(nextDelayMs(3, { jitter: false })).toBeNull();
    setRetryDelays(null);
    expect(nextDelayMs(1, { jitter: false })).toBe(DEFAULT_RETRY_DELAYS_MS[0] ?? 0);
  });
});

let ctx: OutboundTestCtx;
let receiver: MockReceiver;

beforeAll(async () => {
  ctx = await createOutboundCtx("retry");
  receiver = await startMockReceiver();
});

afterAll(async () => {
  await receiver.close();
  await ctx.cleanup();
});

afterEach(() => {
  // Always restore the production ladder between tests so an early
  // failure in one case can't leak shrunk delays into the next case.
  setRetryDelays(null);
});

describe("outbound: retry ladder (integration)", () => {
  test("flaky receiver: 3x 503 then 200, ladder shrunk to [5,5,5] yields 4 attempts ending in delivered", async () => {
    setRetryDelays([5, 5, 5]);
    // Reconfigure the receiver: 503 for attempts 1..3 then 200.
    receiver.hits.length = 0;
    receiver.behavior = (_hit, idx) => (idx < 3 ? 503 : 200);

    const sub = await ctx.createSub({
      event_pattern: "execution.*",
      target_url: receiver.url,
      secret: "whsec_retryflakytestaaaaaaaaaaaa",
    });
    const { handle } = await registerDeliveryWorker({
      boss: ctx.boss,
      db: ctx.db,
      fetchImpl: fetch,
      jitter: false,
      noWork: true,
    });

    const body = '{"type":"execution.succeeded"}';

    // Drive 4 attempts directly. Each handle() call advances a single
    // attempt and writes a row.
    const refTimes: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      const before = Date.now();
      const job: WebhookDeliverJob = {
        tenant_id: ctx.tenantId,
        subscription_id: sub.id,
        event_id: "00000000-0000-0000-0000-0000000000a1",
        event_type: "execution.succeeded",
        body,
        webhook_id: `msg_flaky_${attempt}`,
        // allow-wall-clock: this test exercises real-time polling or freshness windows.
        timestamp: Math.floor(Date.now() / 1000),
        attempt_number: attempt,
      };
      await handle({
        id: `job-${attempt}`,
        name: "webhook.deliver",
        data: job,
      } as unknown as Job<WebhookDeliverJob>);
      refTimes.push(before);
    }

    const rows = await ctx.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.subscription_id, sub.id))
      .orderBy(deliveries.attempt_number);

    expect(rows.length).toBe(4);
    expect(rows[0]?.status).toBe("retrying");
    expect(rows[1]?.status).toBe("retrying");
    expect(rows[2]?.status).toBe("retrying");
    expect(rows[3]?.status).toBe("success");
    expect(rows[3]?.response_code).toBe(200);

    // Each retry's next_retry_at should be approximately +5ms from the
    // moment the row was created. 1s tolerance accounts for jitter +
    // scheduling noise inside the test loop.
    for (let i = 0; i < 3; i += 1) {
      const row = rows[i];
      expect(row?.next_retry_at).not.toBeNull();
      const actual = new Date(row?.next_retry_at ?? 0).getTime();
      const ref = refTimes[i] ?? 0;
      // 5ms target, allow a generous ±1s window.
      expect(actual).toBeGreaterThanOrEqual(ref + 5 - 1_000);
      expect(actual).toBeLessThanOrEqual(ref + 5 + 1_000);
    }
    // The final success row carries no next_retry_at.
    expect(rows[3]?.next_retry_at).toBeNull();
  });

  test("ladder exhaustion: receiver always 500, shrunk to [1,1], 3rd attempt is dead_letter", async () => {
    setRetryDelays([1, 1]);
    receiver.hits.length = 0;
    receiver.behavior = (_hit, _idx) => 500;

    const sub = await ctx.createSub({
      event_pattern: "execution.*",
      target_url: receiver.url,
      secret: "whsec_retryexhaustaaaaaaaaaaaaaa",
    });
    const { handle } = await registerDeliveryWorker({
      boss: ctx.boss,
      db: ctx.db,
      fetchImpl: fetch,
      jitter: false,
      noWork: true,
    });

    const body = '{"type":"execution.succeeded"}';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job: WebhookDeliverJob = {
        tenant_id: ctx.tenantId,
        subscription_id: sub.id,
        event_id: "00000000-0000-0000-0000-0000000000a2",
        event_type: "execution.succeeded",
        body,
        webhook_id: `msg_exhaust_${attempt}`,
        // allow-wall-clock: this test exercises real-time polling or freshness windows.
        timestamp: Math.floor(Date.now() / 1000),
        attempt_number: attempt,
      };
      await handle({
        id: `job-${attempt}`,
        name: "webhook.deliver",
        data: job,
      } as unknown as Job<WebhookDeliverJob>);
    }

    const rows = await ctx.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.subscription_id, sub.id)))
      .orderBy(desc(deliveries.attempt_number));

    expect(rows.length).toBe(3);
    // Most recent row first thanks to the desc() above.
    expect(rows[0]?.attempt_number).toBe(3);
    expect(rows[0]?.status).toBe("dead_letter");
    expect(rows[0]?.next_retry_at).toBeNull();
    expect(rows[1]?.status).toBe("retrying");
    expect(rows[2]?.status).toBe("retrying");
  });
});
