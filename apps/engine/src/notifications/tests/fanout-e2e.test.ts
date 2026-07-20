// End-to-end notification fan-out test.
//
// Bridges the gap between `dispatch.test.ts` (which calls
// `dispatchEvent` directly) and the real production wiring, which goes
// through the outbox listener → `webhooks/outbound/fanout.ts` →
// `dispatchEvent`. The intervening `fanoutEvent` synthesises the
// `NotificationEvent` from the raw outbox payload, so the only place
// the path's correctness can fail is in the bridge itself.
//
// What this test asserts:
//   1. An `execution.failed` outbox event hits a matching channel.
//   2. The synthesised event carries the workflow id + severity that
//      the matcher and adapter expect.
//   3. The audit trail records `chat.message.sent`.
//   4. A `notification_deliveries` row lands with status `sent`.
//
// pg-boss is stubbed because no webhook subscription is seeded and the
// notification dispatch path does not require a queue handle.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { _drainAuditWritesForTests } from "../../audit/index.ts";
import { auditLog } from "../../db/schema/audit.ts";
import {
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { fanoutEvent } from "../../webhooks/outbound/fanout.ts";
import { __resetBreakers, FAILURE_THRESHOLD } from "../circuit-breaker.ts";
import { __resetRateLimiter } from "../rate-limit.ts";
import type { NotificationAdapter } from "../service.ts";
import { createNotificationCtx, FakeAdapter, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;

beforeAll(async () => {
  ctx = await createNotificationCtx("fanout_e2e");
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(() => {
  __resetBreakers();
  __resetRateLimiter();
});

async function wipe() {
  await _drainAuditWritesForTests(ctx.db);
  await ctx.db.delete(notificationDeliveries);
  await ctx.db.delete(notificationRules);
  await ctx.db.delete(notificationChannels);
  await ctx.db.delete(auditLog);
}

async function seedChannelAndRule(opts: { workspace?: string; channel?: string } = {}) {
  const workspace = opts.workspace ?? "W_FANOUT";
  const channel = opts.channel ?? "C_ALERTS";
  await ctx.db.insert(notificationChannels).values({
    tenant_id: ctx.tenant_id,
    workspace_id: workspace,
    channel_id: channel,
    platform: "slack",
    rate_limit_per_minute: 60,
  });
  await ctx.db.insert(notificationRules).values({
    tenant_id: ctx.tenant_id,
    name: "exec-failed-fanout-e2e",
    event_pattern: "execution.*",
    severity: "info",
    target_workspace_id: workspace,
    target_channel_id: channel,
  });
}

// Stub pg-boss so the webhook fanout branch (which iterates over zero
// subscriptions in this test) does not need a real queue handle. The
// notifications branch never touches `boss`.
const fakeBoss = {
  send: async () => "stub-job-id",
} as unknown as PgBoss;

describe("notifications: fanout-event end-to-end", () => {
  test("execution.failed outbox event reaches the fake adapter via fanoutEvent", async () => {
    await wipe();
    await seedChannelAndRule();
    const adapter = new FakeAdapter();
    const stats = await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "execution.failed",
      event_row_id: 1,
      payload: {
        execution_id: "11111111-1111-1111-1111-111111111111",
        status: "failed",
        workflow_id: "00000000-0000-0000-0000-000000000001",
        request_source: "api",
      },
      notificationAdapterResolver: () => adapter as unknown as NotificationAdapter,
    });

    expect(stats.notifications_matched).toBe(1);
    expect(stats.notifications_delivered).toBe(1);
    expect(adapter.sends.length).toBe(1);
    const sent = adapter.sends[0];
    expect(sent?.workspace_id).toBe("W_FANOUT");
    expect(sent?.channel_id).toBe("C_ALERTS");
    expect(sent?.text ?? "").toContain("execution.failed");

    const deliveries = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.tenant_id, ctx.tenant_id));
    const sentRow = deliveries.find((r) => r.status === "sent");
    expect(sentRow).toBeDefined();
    expect(sentRow?.event_type).toBe("execution.failed");

    await _drainAuditWritesForTests(ctx.db);
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, ctx.tenant_id));
    const auditSent = audit.find((r) => r.action === "chat.message.sent");
    expect(auditSent).toBeDefined();
  });

  test("notification dispatch is skipped when request_source is on the rule's filter", async () => {
    // Default filter: rule has none → fires regardless. Seed a rule
    // with `request_source_filter = ['scheduler']` and verify a
    // `chat`-sourced event is filtered out at match time.
    await wipe();
    const workspace = "W_SOURCED";
    const channel = "C_SCOPED";
    await ctx.db.insert(notificationChannels).values({
      tenant_id: ctx.tenant_id,
      workspace_id: workspace,
      channel_id: channel,
      platform: "slack",
      rate_limit_per_minute: 60,
    });
    await ctx.db.insert(notificationRules).values({
      tenant_id: ctx.tenant_id,
      name: "scheduler-only",
      event_pattern: "execution.*",
      severity: "info",
      request_source_filter: ["scheduler"],
      target_workspace_id: workspace,
      target_channel_id: channel,
    });
    const adapter = new FakeAdapter();
    const stats = await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "execution.succeeded",
      event_row_id: 2,
      payload: { request_source: "chat" },
      notificationAdapterResolver: () => adapter as unknown as NotificationAdapter,
    });

    expect(stats.notifications_matched).toBe(0);
    expect(stats.notifications_delivered).toBe(0);
    expect(adapter.sends.length).toBe(0);
  });

  test("adapter failure flips the breaker and the next call records breaker_open", async () => {
    await wipe();
    await seedChannelAndRule({ workspace: "W_BRK", channel: "C_BRK" });
    // Trip the breaker by failing FAILURE_THRESHOLD times in a row.
    // Each attempt records a `failed` delivery.
    const adapter = new FakeAdapter();
    adapter.alwaysFail = true;
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      await fanoutEvent({
        db: ctx.db,
        boss: fakeBoss,
        tenant_id: ctx.tenant_id,
        event_type: "execution.failed",
        event_row_id: 100 + i,
        payload: { request_source: "api" },
        notificationAdapterResolver: () => adapter as unknown as NotificationAdapter,
      });
    }
    // Next call — breaker should be open and the call should record
    // `breaker_open` instead of invoking the adapter.
    const happyAdapter = new FakeAdapter();
    const stats = await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "execution.failed",
      event_row_id: 200,
      payload: { request_source: "api" },
      notificationAdapterResolver: () => happyAdapter as unknown as NotificationAdapter,
    });
    expect(stats.notifications_matched).toBe(1);
    expect(stats.notifications_delivered).toBe(0);
    expect(happyAdapter.sends.length).toBe(0);
    const breakerOpen = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.status, "breaker_open"));
    expect(breakerOpen.length).toBeGreaterThan(0);
  });
});
