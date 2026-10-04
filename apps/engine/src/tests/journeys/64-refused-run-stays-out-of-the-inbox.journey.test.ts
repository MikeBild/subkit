import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { ChatAdapterRegistry } from "../../chat/registry.ts";
import { SkCliAdapter } from "../../chat/sk-cli/adapter.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { events } from "../../db/schema/events.ts";
import { connectors } from "../../db/schema/index.ts";
import {
  cliNotificationInbox,
  notificationChannels,
  notificationDeliveries,
} from "../../db/schema/notifications.ts";
import { seedDefaultCliNotificationRule } from "../../db/seed.ts";
import { runExecution } from "../../execution/engine.ts";
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
let refusingWorkflowId = "";
let refusedId = "";

async function drainFanout(): Promise<void> {
  const rows = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.tenant_id, ctx.tenantId))
    .orderBy(asc(events.id));
  for (const row of rows.filter((r) => r.id > drainedUpTo)) {
    await fanoutEventRow(ctx.db, ctx.boss, row.id, { notificationAdapterResolver: resolver });
    drainedUpTo = Math.max(drainedUpTo, row.id);
  }
  await _drainAuditWritesForTests(ctx.db);
}

async function eventTypesFor(executionId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ type: events.type })
    .from(events)
    .where(
      and(
        eq(events.tenant_id, ctx.tenantId),
        sql`${events.payload}->>'execution_id' = ${executionId}`,
      ),
    )
    .orderBy(asc(events.id));
  return rows.map((r) => r.type);
}

async function inboxEventTypes(): Promise<string[]> {
  const rows = await ctx.db
    .select({ event_type: cliNotificationInbox.event_type })
    .from(cliNotificationInbox)
    .where(eq(cliNotificationInbox.tenant_id, ctx.tenantId));
  return rows.map((r) => r.event_type);
}

beforeAll(async () => {
  ctx = await createJourneyCtx("refused-run-inbox");
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

  const connector = {
    tenant_id: ctx.tenantId,
    slug: "gmail",
    display_name: "Gmail",
    driver: "http" as const,
    auth_type: "none" as const,
    base_url: "https://gmail.googleapis.com",
    config: {},
  };
  const [prod] = await ctx.db
    .insert(connectors)
    .values({ ...connector, environment: "prod" })
    .returning();
  await ctx.db.insert(connectors).values({ ...connector, environment: "dev", needs_reauth: true });
  const workflow = await seedWorkflow(ctx, {
    slug: "send-digest",
    name: "Send digest",
    steps: [
      {
        id: "send",
        kind: "request",
        connector_id: prod?.id,
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        body: { raw: "ZGlnZXN0" },
      },
    ],
  });
  refusingWorkflowId = workflow.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 64: a refused run stays out of the inbox", () => {
  test("AC1+AC2+AC3: the refusal closes the row without execution.failed or an inbox row", async () => {
    const res = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      headers: { "x-subkit-environment": "dev" },
      body: JSON.stringify({ source: "saved", workflow_id: refusingWorkflowId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { details?: { execution_id?: string } };
    refusedId = String(body.details?.execution_id);

    const types = await eventTypesFor(refusedId);
    expect(types).not.toContain("execution.failed");
    expect(types).toContain("execution.refused");

    await drainFanout();
    const sent = await ctx.db
      .select({ event_type: notificationDeliveries.event_type })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.tenant_id, ctx.tenantId),
          eq(notificationDeliveries.status, "sent"),
        ),
      );
    expect(sent).toEqual([]);
    expect(await inboxEventTypes()).toEqual([]);

    const audited = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, refusedId)));
    expect(audited).toContainEqual({
      action: "execution.boundary_refused",
      reason: "prepared_credential_unavailable",
    });
  });

  test("AC4: a run that fails in its step still reaches the inbox", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "loud-failure",
      name: "Loud Failure",
      steps: [
        { kind: "transform", id: "boom", expression: `(() => { throw new Error("boom"); })()` },
      ],
    });
    const res = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    await res.text();
    await drainFanout();
    expect(await inboxEventTypes()).toEqual(["execution.failed"]);
  });
  test("AC5: a queued run refused in the worker still reaches the inbox", async () => {
    const res = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      headers: { "x-subkit-environment": "dev" },
      body: JSON.stringify({ source: "saved", workflow_id: refusingWorkflowId, async: true }),
    });
    expect(res.status).toBe(202);
    const { execution_id } = (await res.json()) as { execution_id: string };
    await expect(
      runExecution({
        db: ctx.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id: refusingWorkflowId },
        input: null,
        options: {
          request_source: "api",
          existing_execution_id: execution_id,
          execution_mode: "dev",
        },
      }),
    ).rejects.toMatchObject({ code: "prepared_credential_unavailable" });
    const types = await eventTypesFor(execution_id);
    expect(types).toContain("execution.failed");
    expect(types).not.toContain("execution.refused");
    await drainFanout();
    expect(await inboxEventTypes()).toContain("execution.failed");
  });
});
