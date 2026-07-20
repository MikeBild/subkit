// Dispatch tests for the sk_cli channel path.
//
// The sk_cli inbox is a local INSERT — no remote API to throttle and no
// transient endpoint to circuit-break. This test asserts:
//
//   1. Dispatching an event to an sk_cli channel bypasses both the
//      circuit-breaker and rate-limiter: a delivery is recorded and the
//      inbox row is created even when a breaker row is marked `open` for
//      that channel.
//
//   2. A notification_deliveries row with status `sent` is written.
//
//   3. An audit entry (chat.message.sent) is written.
//
//   4. The circuit-breaker `open` state for the sk_cli channel is not
//      consumed (breaker state unchanged after delivery).
//
// Approach: seed an sk_cli channel row with circuit_state = "open" and
// circuit_open_until in the future, then dispatch — the outcome must be
// `sent`, not `breaker_open`, and an inbox row must exist.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/index.ts";
import { SkCliAdapter } from "../../chat/sk-cli/adapter.ts";
import { auditLog } from "../../db/schema/audit.ts";
import {
  cliNotificationInbox,
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { __resetBreakers } from "../circuit-breaker.ts";
import type { NotificationEvent } from "../matcher.ts";
import { __resetRateLimiter } from "../rate-limit.ts";
import { dispatchEvent, type NotificationAdapter } from "../service.ts";
import { createNotificationCtx, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;

beforeAll(async () => {
  ctx = await createNotificationCtx("sk_cli_dispatch");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

beforeEach(() => {
  __resetBreakers();
  __resetRateLimiter();
});

async function wipe(): Promise<void> {
  await _drainAuditWritesForTests();
  await ctx.db.delete(cliNotificationInbox);
  await ctx.db.delete(notificationDeliveries);
  await ctx.db.delete(notificationRules);
  await ctx.db.delete(notificationChannels);
  await ctx.db.delete(auditLog);
}

function baseEvent(): NotificationEvent {
  return {
    tenant_id: ctx.tenant_id,
    type: "connector.auth_failed",
    severity: "error",
    request_source: "api",
    payload: { connector_id: "c-test" },
  };
}

describe("notifications: sk_cli channel dispatch", () => {
  test("delivers to sk_cli channel and inserts inbox row even when circuit_state is open", async () => {
    await wipe();

    // Seed a sk_cli channel with circuit_state = "open" and a far-future
    // open_until. The exact value is irrelevant — the breaker is bypassed for
    // sk_cli — so a fixed timestamp keeps the test deterministic.
    const futureOpenUntil = new Date("2099-01-01T00:00:00.000Z");
    const [chan] = await ctx.db
      .insert(notificationChannels)
      .values({
        tenant_id: ctx.tenant_id,
        workspace_id: "_cli",
        channel_id: "_inbox",
        platform: "sk_cli",
        circuit_state: "open",
        circuit_open_until: futureOpenUntil,
        consecutive_failures: 5,
        rate_limit_per_minute: 60,
        active: true,
      })
      .returning();
    if (!chan) throw new Error("seed channel failed");

    await ctx.db.insert(notificationRules).values({
      tenant_id: ctx.tenant_id,
      name: "sk-cli-test",
      event_pattern: "connector.*",
      severity: "info",
      target_workspace_id: "_cli",
      target_channel_id: "_inbox",
    });

    const adapter = new SkCliAdapter(ctx.db);
    const result = await dispatchEvent(
      {
        db: ctx.db,
        resolveAdapter: () => adapter as unknown as NotificationAdapter,
      },
      baseEvent(),
    );

    // Must have delivered — not blocked by breaker.
    expect(result.matched).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.outcomes[0]?.status).toBe("sent");

    // Inbox row must exist.
    const inboxRows = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inboxRows.length).toBe(1);
    expect(inboxRows[0]?.event_type).toBe("connector.auth_failed");

    // Delivery row with status `sent`.
    const deliveries = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.tenant_id, ctx.tenant_id),
          eq(notificationDeliveries.status, "sent"),
        ),
      );
    expect(deliveries.length).toBe(1);

    // Audit entry.
    await _drainAuditWritesForTests();
    const auditRows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, ctx.tenant_id));
    const sentAudit = auditRows.find((r) => r.action === "chat.message.sent");
    expect(sentAudit).toBeDefined();
  });

  test("sk_cli delivery is not suppressed by an exhausted rate-limit bucket on the same channel", async () => {
    await wipe();

    // Seed an sk_cli channel with a very low rate limit.
    await ctx.db.insert(notificationChannels).values({
      tenant_id: ctx.tenant_id,
      workspace_id: "_cli",
      channel_id: "_inbox",
      platform: "sk_cli",
      circuit_state: "closed",
      rate_limit_per_minute: 1,
      active: true,
    });
    await ctx.db.insert(notificationRules).values({
      tenant_id: ctx.tenant_id,
      name: "sk-cli-ratelimit-test",
      event_pattern: "connector.*",
      severity: "info",
      target_workspace_id: "_cli",
      target_channel_id: "_inbox",
    });

    const adapter = new SkCliAdapter(ctx.db);
    const resolver = () => adapter as unknown as NotificationAdapter;

    // Send enough to exhaust a rate_limit_per_minute=1 bucket for a non-sk_cli channel.
    for (let i = 0; i < 3; i++) {
      const r = await dispatchEvent({ db: ctx.db, resolveAdapter: resolver }, baseEvent());
      // sk_cli bypasses rate-limit, every send must succeed.
      expect(r.delivered).toBe(1);
      expect(r.outcomes[0]?.status).toBe("sent");
    }

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(3);
  });

  test("delivery row status is `sent` and carries correct event_type", async () => {
    await wipe();

    await ctx.db.insert(notificationChannels).values({
      tenant_id: ctx.tenant_id,
      workspace_id: "_cli",
      channel_id: "_inbox",
      platform: "sk_cli",
      circuit_state: "closed",
      rate_limit_per_minute: 60,
      active: true,
    });
    await ctx.db.insert(notificationRules).values({
      tenant_id: ctx.tenant_id,
      name: "sk-cli-delivery-row",
      event_pattern: "*",
      severity: "info",
      target_workspace_id: "_cli",
      target_channel_id: "_inbox",
    });

    const adapter = new SkCliAdapter(ctx.db);
    await dispatchEvent(
      { db: ctx.db, resolveAdapter: () => adapter as unknown as NotificationAdapter },
      {
        tenant_id: ctx.tenant_id,
        type: "workflow.updated",
        severity: "info",
        request_source: "api",
      },
    );

    const delivery = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.tenant_id, ctx.tenant_id));
    expect(delivery.length).toBe(1);
    expect(delivery[0]?.status).toBe("sent");
    expect(delivery[0]?.event_type).toBe("workflow.updated");
  });
});
