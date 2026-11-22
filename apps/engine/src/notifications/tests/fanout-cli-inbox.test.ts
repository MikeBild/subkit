import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { SubkitCliAdapter } from "../../chat/subkit-cli/adapter.ts";
import {
  cliNotificationInbox,
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { fanoutEvent } from "../../webhooks/outbound/fanout.ts";
import { __resetBreakers } from "../circuit-breaker.ts";
import { __resetRateLimiter } from "../rate-limit.ts";
import type { NotificationAdapter } from "../service.ts";
import { createNotificationCtx, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;
let tenantBId: string;

const fakeBoss = {
  send: async () => "stub-job-id",
} as unknown as PgBoss;

beforeAll(async () => {
  ctx = await createNotificationCtx("fanout_cli_inbox");

  const tB = await seedTenant(ctx.db, { slug: "fanout-cli-b", display_name: "Fanout CLI B" });
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

async function seedDefaultCliRule(tenantId: string = ctx.tenant_id): Promise<void> {
  await ctx.db.insert(notificationRules).values({
    tenant_id: tenantId,
    name: "subkit CLI inbox (default)",
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
  const adapter = new SubkitCliAdapter(db);
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
      event_type: "execution.failed",
      event_row_id: 2,
      payload: {
        request_source: "api",
        ...{
          execution_id: "00000000-0000-4000-8000-0000000000e9",
          workflow_id: "00000000-0000-4000-8000-0000000000f9",
        },
      },
      notificationAdapterResolver: resolver,
    });

    const inbox = await ctx.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenant_id));
    expect(inbox.length).toBe(1);
  });

  test("debug-severity event is NOT queued (info is the floor)", async () => {
    await wipe();
    await seedDefaultCliRule();
    const resolver = makeAdapterResolver(ctx.db);

    const stats = await fanoutEvent({
      db: ctx.db,
      boss: fakeBoss,
      tenant_id: ctx.tenant_id,
      event_type: "debug.event",
      event_row_id: 3,
      payload: { severity: "debug" },
      notificationAdapterResolver: resolver,
    });

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

  test("a purely informational event leaves no inbox row: a row is a task", async () => {
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
    expect(inbox.length).toBe(0);
  });

  test("an unknown event type leaves no row and does not throw", async () => {
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
    expect(inbox.length).toBe(0);
  });
});
