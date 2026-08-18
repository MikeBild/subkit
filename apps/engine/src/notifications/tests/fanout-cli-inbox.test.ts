// End-to-end fanout test for the default _cli/_inbox rule.
//
// Asserts:
//   1. A tenant seeded with the default `_cli/_inbox` rule emits exactly
//      ONE cli_notification_inbox row when fanoutEvent is called with a
//      matching event (severity >= info floor).
//   2. The row carries the correct event_type.
//   3. A `debug`-severity event is NOT queued (severity floor is `info`).
//   4. NO double-row when only the default rule exists and a single event
//      is dispatched.
//   5. Cross-tenant: inbox row for tenant A is not visible in tenant B.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { SkCliAdapter } from "../../chat/sk-cli/adapter.ts";
import { tenants } from "../../db/schema/index.ts";
import {
  cliNotificationInbox,
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { fanoutEvent } from "../../webhooks/outbound/fanout.ts";
import { __resetBreakers } from "../circuit-breaker.ts";
import { __resetRateLimiter } from "../rate-limit.ts";
import type { NotificationAdapter } from "../service.ts";
import { createNotificationCtx, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;
// A second tenant to verify cross-tenant isolation.
let tenantBId: string;

const fakeBoss = {
  send: async () => "stub-job-id",
} as unknown as PgBoss;

beforeAll(async () => {
  ctx = await createNotificationCtx("fanout_cli_inbox");

  // Seed a second tenant for cross-tenant assertions.
  const [tB] = await ctx.db
    .insert(tenants)
    .values({ slug: "fanout-cli-b", display_name: "Fanout CLI B" })
    .returning();
  if (!tB) throw new Error("seed tenant B failed");
  tenantBId = tB.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

beforeEach(() => {
  __resetBreakers();
  __resetRateLimiter();
});

async function wipe(): Promise<void> {
  await ctx.db.delete(cliNotificationInbox);
  await ctx.db.delete(notificationDeliveries);
  await ctx.db.delete(notificationRules);
  await ctx.db.delete(notificationChannels);
}

/** Seed the default _cli/_inbox rule for the primary tenant. */
async function seedDefaultCliRule(tenantId: string = ctx.tenant_id): Promise<void> {
  await ctx.db.insert(notificationRules).values({
    tenant_id: tenantId,
    name: "sk CLI inbox (default)",
    event_pattern: "*",
    workflow_pattern: "*",
    severity: "info",
    request_source_filter: null,
    target_workspace_id: "_cli",
    target_channel_id: "_inbox",
    active: true,
  });
}

function makeAdapterResolver(db: typeof ctx.db) {
  const adapter = new SkCliAdapter(db);
  return () => adapter as unknown as NotificationAdapter;
}

describe("notifications: fanout → _cli/_inbox end-to-end", () => {
  test("exactly ONE inbox row is created for a matching info-level event", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);

    const stats = await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "connector.auth_failed",
      event_row_id: 1,
      payload: { severity: "error", connector_id: "c-test" },
      notificationAdapterResolver: resolver,
    });

    expect(stats.notifications_matched).toBe(1);
    expect(stats.notifications_delivered).toBe(1);

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.event_type).toBe("connector.auth_failed");
  });

  test("no double-row when only the default rule exists and a single event is dispatched", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);

    await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "workflow.updated",
      event_row_id: 2,
      payload: { request_source: "api" },
      notificationAdapterResolver: resolver,
    });

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    // Exactly one row — no duplication from the single default rule.
    expect(inbox.length).toBe(1);
  });

  test("debug-severity event is NOT queued (info is the floor)", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);

    // The default rule has severity floor `info`. The fanout derives
    // event severity from the payload or defaults to "info". To force a
    // debug severity we need to pass it explicitly in payload.
    const stats = await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "debug.event",
      event_row_id: 3,
      // severity="debug" < floor="info" → should NOT match
      payload: { severity: "debug" },
      notificationAdapterResolver: resolver,
    });

    // The matcher should filter this out because event severity (debug) < rule floor (info).
    expect(stats.notifications_matched).toBe(0);
    expect(stats.notifications_delivered).toBe(0);

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(0);
  });

  test("cross-tenant: inbox row for tenant A is not visible in tenant B", async () => {
    await wipe();
    await seedDefaultCliRule(ctx.tenant_id);
    const resolver = makeAdapterResolver(ctx.db);

    await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "execution.failed",
      event_row_id: 4,
      payload: { request_source: "api" },
      notificationAdapterResolver: resolver,
    });

    const inboxA = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    const inboxB = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantBId));

    expect(inboxA.length).toBe(1);
    expect(inboxB.length).toBe(0);
  });

  test("inbox row carries severity and event_type from the dispatched event", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);

    await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "execution.failed",
      event_row_id: 5,
      payload: { request_source: "api", workflow_id: "wf-aaa" },
      notificationAdapterResolver: resolver,
    });

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(1);
    // The CLI inbox carries the EVENT's own severity (execution.failed → "error"),
    // not the rule's matching floor ("info") — so a critical alert reads as
    // "error" in the inbox, not "info". (The deliveries audit + Slack header
    // still use the floor; that's a separate, unchanged contract.)
    expect(inbox[0]?.severity).toBe("error");
    expect(inbox[0]?.event_type).toBe("execution.failed");
  });

  test("an actionable event lands with actionable=true and a resource pointer", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);
    const connectorId = "00000000-0000-4000-8000-0000000000c1";

    await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "connector.auth_failed",
      event_row_id: 6,
      payload: { severity: "error", connector_id: connectorId, reason: "credential_rejected" },
      notificationAdapterResolver: resolver,
    });

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.actionable).toBe(true);
    expect(inbox[0]?.resource_type).toBe("connector");
    expect(inbox[0]?.resource_id).toBe(connectorId);
  });

  test("a purely informational event lands with actionable=false", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);

    await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "execution.succeeded",
      event_row_id: 7,
      payload: {
        execution_id: "00000000-0000-4000-8000-0000000000e1",
        workflow_id: "00000000-0000-4000-8000-0000000000f1",
        duration_ms: 12,
      },
      notificationAdapterResolver: resolver,
    });

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.event_type).toBe("execution.succeeded");
    expect(inbox[0]?.actionable).toBe(false);
  });

  test("an unknown event type lands all-null/false without throwing", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);

    await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "totally.unknown.event",
      event_row_id: 8,
      payload: { severity: "warn", whatever: true },
      notificationAdapterResolver: resolver,
    });

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.actionable).toBe(false);
    expect(inbox[0]?.resource_type).toBeNull();
    expect(inbox[0]?.resource_id).toBeNull();
  });
});
