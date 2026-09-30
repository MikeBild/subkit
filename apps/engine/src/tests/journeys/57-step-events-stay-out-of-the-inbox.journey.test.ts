// User story: As an operator, I want a running workflow to leave the
// notification log quiet — a step starting or finishing is not something a
// person has to act on, so it must not show up as a sent notification or a
// `chat.message.sent` audit row. A failed run still has to reach my inbox.
// Acceptance criteria:
//   - AC1: A tenant seeded with its default sk CLI inbox rule runs a
//          multi-step workflow; draining the event fan-out the way the
//          production worker does (chat registry with the `sk_cli`
//          fallback) records no `sent` delivery and no `chat.message.sent`
//          audit row for any `execution.step.*` event.
//   - AC2: A failing run still produces a `sent` delivery, an audit row and
//          an inbox row for `execution.failed`.
//   - AC3: A user-made `*` rule on the inbox still sees step events, but the
//          adapter skips them: a `skipped` delivery, no `sent` row, no audit.
// Spec refs: docs/operators/notifications.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, like } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { ChatAdapterRegistry } from "../../chat/registry.ts";
import { SkCliAdapter } from "../../chat/sk-cli/adapter.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { events } from "../../db/schema/events.ts";
import {
  cliNotificationInbox,
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { seedDefaultCliNotificationRule } from "../../db/seed.ts";
import type { AdapterResolver } from "../../notifications/service.ts";
import { fanoutEventRow, makeRegistryAdapterResolver } from "../../webhooks/outbound/fanout.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let resolver: AdapterResolver;
/** Outbox rows already drained by this file, so each test fans out only its own. */
let drainedUpTo = 0;

/** Fan out every not-yet-drained outbox row of the tenant through the same
 *  resolver the production `event.fanout` worker builds at boot. */
async function drainFanout(): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: events.id, type: events.type })
    .from(events)
    .where(eq(events.tenant_id, ctx.tenantId))
    .orderBy(asc(events.id));
  const fresh = rows.filter((r) => r.id > drainedUpTo);
  for (const row of fresh) {
    await fanoutEventRow(ctx.db, ctx.boss, row.id, { notificationAdapterResolver: resolver });
    drainedUpTo = Math.max(drainedUpTo, row.id);
  }
  await _drainAuditWritesForTests(ctx.db);
  return fresh.map((r) => r.type);
}

async function runWorkflow(workflowId: string): Promise<void> {
  const res = await journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
  });
  // A failing run may answer non-2xx; the outbox carries its events either way.
  await res.text();
}

async function sentStepDeliveries(): Promise<number> {
  const rows = await ctx.db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.tenant_id, ctx.tenantId),
        eq(notificationDeliveries.status, "sent"),
        like(notificationDeliveries.event_type, "execution.step.%"),
      ),
    );
  return rows.length;
}

async function sentAuditEventTypes(): Promise<string[]> {
  const rows = await ctx.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "chat.message.sent")));
  return rows.map((r) => String((r.metadata as Record<string, unknown> | null)?.event_type ?? ""));
}

beforeAll(async () => {
  ctx = await createJourneyCtx("step-events-inbox");
  await seedDefaultCliNotificationRule(ctx.db, ctx.tenantId);
  // Pre-create the inbox channel row: the background fan-out worker and this
  // file's drain both resolve it, and neither should race to create it.
  await ctx.db.insert(notificationChannels).values({
    tenant_id: ctx.tenantId,
    workspace_id: "_cli",
    channel_id: "_inbox",
    platform: "sk_cli",
    active: true,
  });
  const registry = new ChatAdapterRegistry();
  registry.registerFallback("sk_cli", new SkCliAdapter(ctx.db));
  resolver = makeRegistryAdapterResolver(registry);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 57: step events stay out of the notification log", () => {
  test("AC1: a multi-step run under the default rule sends nothing per step", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "quiet-steps",
      name: "Quiet Steps",
      steps: [
        { kind: "transform", id: "first", expression: `"one"` },
        { kind: "transform", id: "second", expression: `"two"` },
        { kind: "transform", id: "third", expression: `"three"` },
      ],
    });
    await runWorkflow(wf.id);
    const types = await drainFanout();
    // The run really emitted step events — otherwise the absence below proves nothing.
    expect(types.filter((t) => t.startsWith("execution.step.")).length).toBeGreaterThanOrEqual(6);

    expect(await sentStepDeliveries()).toBe(0);
    const audited = await sentAuditEventTypes();
    expect(audited.filter((t) => t.startsWith("execution.step."))).toEqual([]);
  });

  test("AC2: a failed run still reaches the inbox", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "loud-failure",
      name: "Loud Failure",
      steps: [
        { kind: "transform", id: "ok", expression: `"fine"` },
        { kind: "transform", id: "boom", expression: `(() => { throw new Error("boom"); })()` },
      ],
    });
    await runWorkflow(wf.id);
    const types = await drainFanout();
    expect(types).toContain("execution.failed");

    const failed = await ctx.db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.tenant_id, ctx.tenantId),
          eq(notificationDeliveries.status, "sent"),
          eq(notificationDeliveries.event_type, "execution.failed"),
        ),
      );
    expect(failed.length).toBe(1);
    expect(await sentAuditEventTypes()).toContain("execution.failed");
    const inbox = await ctx.db
      .select({ event_type: cliNotificationInbox.event_type })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, ctx.tenantId));
    expect(inbox.map((r) => r.event_type)).toEqual(["execution.failed"]);
    expect(await sentStepDeliveries()).toBe(0);
  });

  test("AC3: a user-made catch-all inbox rule skips step events without a sent row or audit", async () => {
    await ctx.db.insert(notificationRules).values({
      tenant_id: ctx.tenantId,
      name: "everything into my inbox",
      event_pattern: "*",
      severity: "info",
      target_workspace_id: "_cli",
      target_channel_id: "_inbox",
    });
    const wf = await seedWorkflow(ctx, {
      slug: "catch-all-steps",
      name: "Catch-all Steps",
      steps: [
        { kind: "transform", id: "a", expression: `"a"` },
        { kind: "transform", id: "b", expression: `"b"` },
      ],
    });
    await runWorkflow(wf.id);
    const types = await drainFanout();
    expect(types.filter((t) => t.startsWith("execution.step.")).length).toBeGreaterThanOrEqual(4);

    const skipped = await ctx.db
      .select({ reason: notificationDeliveries.reason })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.tenant_id, ctx.tenantId),
          eq(notificationDeliveries.status, "skipped"),
          like(notificationDeliveries.event_type, "execution.step.%"),
          eq(notificationDeliveries.reason, "not_actionable"),
        ),
      );
    expect(skipped.length).toBeGreaterThanOrEqual(4);
    expect(await sentStepDeliveries()).toBe(0);
    const audited = await sentAuditEventTypes();
    expect(audited.filter((t) => t.startsWith("execution.step."))).toEqual([]);
  });
});
