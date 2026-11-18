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
import { seedDefaultCliNotificationRule } from "../../notifications/default-cli-rule.ts";
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
let drainedUpTo = 0;

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
