// End-to-end dispatch test. Seeds a channel + rule, publishes an
// `execution.failed` event, confirms the fake adapter was hit, then
// exhausts the rate limit and trips the circuit breaker.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { ChatAdapterRegistry } from "../../chat/registry.ts";
import {
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { fanoutEvent } from "../../webhooks/outbound/fanout.ts";
import { __resetBreakers, FAILURE_THRESHOLD, OPEN_DURATION_MS } from "../circuit-breaker.ts";
import type { NotificationEvent } from "../matcher.ts";
import { __resetRateLimiter } from "../rate-limit.ts";
import { dispatchEvent, type NotificationAdapter } from "../service.ts";
import { createNotificationCtx, FakeAdapter, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;

beforeAll(async () => {
  ctx = await createNotificationCtx("dispatch");
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(() => {
  __resetBreakers();
  __resetRateLimiter();
});

async function wipeState() {
  await ctx.db.delete(notificationDeliveries);
  await ctx.db.delete(notificationRules);
  await ctx.db.delete(notificationChannels);
}

function baseEvent(): NotificationEvent {
  return {
    tenant_id: ctx.tenant_id,
    type: "execution.failed",
    severity: "error",
    request_source: "api",
    payload: { reason: "timeout", workflow_id: "00000000-0000-0000-0000-000000000001" },
    workflow_id: "00000000-0000-0000-0000-000000000001",
  };
}

async function seedChannelAndRule(
  params: { rate_limit_per_minute?: number; workspace?: string; channel?: string } = {},
) {
  const workspace = params.workspace ?? "W_DISPATCH";
  const channel = params.channel ?? "C_ONCALL";
  await ctx.db.insert(notificationChannels).values({
    tenant_id: ctx.tenant_id,
    workspace_id: workspace,
    channel_id: channel,
    platform: "slack",
    rate_limit_per_minute: params.rate_limit_per_minute ?? 60,
  });
  await ctx.db.insert(notificationRules).values({
    tenant_id: ctx.tenant_id,
    name: "exec-errors",
    event_pattern: "execution.*",
    severity: "info",
    target_workspace_id: workspace,
    target_channel_id: channel,
  });
}

describe("notifications: dispatchEvent", () => {
  test("delivers a matching event to the fake adapter", async () => {
    await wipeState();
    await seedChannelAndRule();
    const adapter = new FakeAdapter();
    const result = await dispatchEvent(
      { db: ctx.db, resolveAdapter: () => adapter as unknown as NotificationAdapter },
      baseEvent(),
    );
    expect(result.matched).toBe(1);
    expect(result.delivered).toBe(1);
    expect(adapter.sends.length).toBe(1);
    const sent = adapter.sends[0];
    expect(sent?.channel_id).toBe("C_ONCALL");
    expect(sent?.workspace_id).toBe("W_DISPATCH");
    expect(sent?.text ?? "").toContain("execution.failed");
    const deliveryRows = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.tenant_id, ctx.tenant_id));
    expect(deliveryRows.some((r) => r.status === "sent")).toBe(true);
  });

  test("rate limit rejects excess dispatches on the same channel", async () => {
    await wipeState();
    await seedChannelAndRule({ rate_limit_per_minute: 3 });
    const adapter = new FakeAdapter();

    for (let i = 0; i < 3; i += 1) {
      const r = await dispatchEvent(
        { db: ctx.db, resolveAdapter: () => adapter as unknown as NotificationAdapter },
        baseEvent(),
      );
      expect(r.delivered).toBe(1);
    }
    const fourth = await dispatchEvent(
      { db: ctx.db, resolveAdapter: () => adapter as unknown as NotificationAdapter },
      baseEvent(),
    );
    expect(fourth.delivered).toBe(0);
    expect(fourth.outcomes[0]?.status).toBe("rate_limited");
    expect(adapter.sends.length).toBe(3);
    const limited = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.status, "rate_limited"));
    expect(limited.length).toBeGreaterThan(0);
  });

  test("fanoutEvent with chatRegistry routes matching rules through the registered adapter", async () => {
    await wipeState();
    await seedChannelAndRule({ workspace: "W_REGISTRY", channel: "C_REGISTRY" });

    const adapter = new FakeAdapter();
    const registry = new ChatAdapterRegistry();
    registry.register(
      {
        tenant_id: ctx.tenant_id,
        platform: "slack",
        workspace_id: "W_REGISTRY",
      },
      adapter,
    );

    // Resolver built from the registry — same shape the fanout worker
    // uses at runtime.
    const { makeRegistryAdapterResolver } = await import("../../webhooks/outbound/fanout.ts");
    const resolver = makeRegistryAdapterResolver(registry);

    // Fake pg-boss — fanoutEvent calls boss.send for each matching
    // webhook subscription. There are no subscriptions in this test,
    // so the stub is never invoked, but fanoutEvent's signature still
    // requires one.
    const fakeBoss = {
      send: async () => null,
    } as unknown as Parameters<typeof fanoutEvent>[0]["boss"];

    const stats = await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_row_id: 1,
      event_type: "execution.failed",
      payload: { reason: "boom", workflow_id: "00000000-0000-0000-0000-000000000001" },
      notificationAdapterResolver: resolver,
    });

    expect(stats.notifications_matched).toBe(1);
    expect(stats.notifications_delivered).toBe(1);
    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0]?.channel_id).toBe("C_REGISTRY");

    const rows = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.tenant_id, ctx.tenant_id));
    expect(rows.some((r) => r.status === "sent")).toBe(true);
  });

  test("circuit breaker opens after repeated adapter failures and blocks further sends", async () => {
    await wipeState();
    await seedChannelAndRule();
    const adapter = new FakeAdapter();
    adapter.alwaysFail = true;

    // Drive failures up to the threshold.
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const t0 = Date.now();
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      const r = await dispatchEvent(
        {
          db: ctx.db,
          resolveAdapter: () => adapter as unknown as NotificationAdapter,
          now: () => t0,
        },
        baseEvent(),
      );
      expect(r.outcomes[0]?.status).toBe("failed");
    }
    const [chan] = await ctx.db.select().from(notificationChannels).limit(1);
    expect(chan?.circuit_state).toBe("open");
    expect(chan?.consecutive_failures).toBe(FAILURE_THRESHOLD);

    // Next dispatch should be blocked by the breaker without calling
    // the adapter at all. Stop forcing failures so we can be sure the
    // skip comes from the breaker, not a throw.
    adapter.alwaysFail = false;
    const before = adapter.sends.length;
    const blocked = await dispatchEvent(
      {
        db: ctx.db,
        resolveAdapter: () => adapter as unknown as NotificationAdapter,
        now: () => t0 + 1_000,
      },
      baseEvent(),
    );
    expect(blocked.delivered).toBe(0);
    expect(blocked.outcomes[0]?.status).toBe("breaker_open");
    expect(adapter.sends.length).toBe(before);

    // After the cool-down a probe should go through (half-open) and
    // close the breaker on success.
    const afterCool = t0 + OPEN_DURATION_MS + 1_000;
    const probe = await dispatchEvent(
      {
        db: ctx.db,
        resolveAdapter: () => adapter as unknown as NotificationAdapter,
        now: () => afterCool,
      },
      baseEvent(),
    );
    expect(probe.delivered).toBe(1);
    const [after] = await ctx.db.select().from(notificationChannels).limit(1);
    expect(after?.circuit_state).toBe("closed");
    expect(after?.consecutive_failures).toBe(0);
  });
});
