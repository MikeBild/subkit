import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, webhooksInbound } from "../../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { applyTriggerBindings } from "../../../workflows/trigger-bindings.ts";
import { bindFromWorkflow, unbindFromWorkflow } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const deterministicUuid = createDeterministicUuidFactory(0x71b1d);

let ctx: InboundTestCtx;

beforeEach(async () => {
  ctx = await createInboundCtx("trigger-bind");
});

afterEach(async () => {
  await ctx.cleanup();
});

const triggerStripe = {
  kind: "webhook" as const,
  source: "stripe",
  events: ["invoice.paid"],
  verify: "stripe-signature" as const,
};

describe("inbound trigger bind/unbind helpers", () => {
  test("request activation preserves separately managed signed bindings", async () => {
    const binding = await ctx.createBinding({
      slug: "signed-contact",
      verifier: "standard",
      secret: "controlled-test-signing-secret",
      native_verifier_config: { events: ["contact.submitted"] },
    });
    const before = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, binding.id)));
    await applyTriggerBindings(
      ctx.db,
      ctx.tenantId,
      ctx.workflowId,
      "wf-test",
      {
        name: "Contact",
        steps: [],
        trigger: { kind: "request" },
      },
      null,
    );
    const after = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, binding.id)));
    expect(after).toEqual(before);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, binding.id),
          eq(auditLog.action, "webhook.trigger.unbound"),
        ),
      );
    expect(audits).toHaveLength(0);
  });

  test("trigger changes preserve independent bindings and remove only the managed trigger", async () => {
    const independent = await ctx.createBinding({
      slug: "wf-test",
      verifier: "standard",
      secret: "controlled-test-signing-secret",
      native_verifier_config: { events: ["contact.submitted"] },
    });
    const managed = await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: triggerStripe,
        actor_id: null,
      },
      ctx.db,
    );
    expect(managed.row.id).not.toBe(independent.id);
    expect(
      await unbindFromWorkflow(deterministicUuid(), ctx.workflowId, null, ctx.db, "trigger"),
    ).toBe(0);
    await applyTriggerBindings(
      ctx.db,
      ctx.tenantId,
      ctx.workflowId,
      "wf-test",
      {
        name: "Contact",
        steps: [],
        trigger: { kind: "request" },
      },
      null,
    );
    const remaining = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, ctx.tenantId),
          eq(webhooksInbound.workflow_id, ctx.workflowId),
        ),
      );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      id: independent.id,
      origin: "crud",
      verifier: "standard",
    });
    expect(remaining[0]?.native_verifier_config).toEqual({ events: ["contact.submitted"] });
    expect(await unbindFromWorkflow(ctx.tenantId, ctx.workflowId, null, ctx.db)).toBe(1);
  });

  test("schedule activation preserves separately managed signed bindings", async () => {
    const binding = await ctx.createBinding({
      slug: "scheduled-contact",
      verifier: "standard",
      secret: "controlled-test-signing-secret",
    });
    await applyTriggerBindings(
      ctx.db,
      ctx.tenantId,
      ctx.workflowId,
      "wf-test",
      {
        name: "Contact",
        steps: [],
        trigger: { kind: "schedule", cron: "0 9 * * *", tz: "Europe/Berlin" },
      },
      null,
    );
    const rows = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, binding.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "crud", verifier: "standard" });
  });

  test("trigger audit preserves explicit actor types and leaves background actor empty", async () => {
    const userId = deterministicUuid();
    const accountId = deterministicUuid();
    const user = await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: triggerStripe,
        actor_id: userId,
        actor: { kind: "user", id: userId },
      },
      ctx.db,
    );
    await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: { ...triggerStripe, events: ["invoice.created"] },
        actor_id: accountId,
        actor: { kind: "system_account", id: accountId },
      },
      ctx.db,
    );
    await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: { ...triggerStripe, events: ["invoice.updated"] },
        actor_id: null,
      },
      ctx.db,
    );
    const rows = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, user.row.id),
          eq(auditLog.action, "webhook.trigger.bound"),
        ),
      );
    expect(rows).toEqual([
      { actor_type: "user", actor_id: userId },
      { actor_type: "system_account", actor_id: accountId },
      { actor_type: "system", actor_id: null },
    ]);
  });

  test("bindFromWorkflow creates a single inbound row, idempotent on repeat", async () => {
    const first = await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: triggerStripe,
        actor_id: null,
      },
      ctx.db,
    );
    expect(first.status).toBe("created");
    expect(first.row.verifier).toBe("stripe");
    expect(first.row.slug).toBe("wf-wf-test");

    const second = await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: triggerStripe,
        actor_id: null,
      },
      ctx.db,
    );
    expect(second.status).toBe("noop");
    expect(second.row.id).toBe(first.row.id);

    const allRows = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, ctx.tenantId),
          eq(webhooksInbound.workflow_id, ctx.workflowId),
        ),
      );
    expect(allRows.length).toBe(1);
  });

  test("bindFromWorkflow emits a WEBHOOK_TRIGGER_BOUND audit row on create", async () => {
    await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: triggerStripe,
        actor_id: null,
      },
      ctx.db,
    );
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "webhook.trigger.bound")),
      );
    expect(audits.length).toBe(1);
    const row = audits[0];
    expect(row?.resource_type).toBe("webhook_inbound");
    expect((row!.metadata as Record<string, unknown>)?.kind).toBe("create");
    expect((row!.metadata as Record<string, unknown>)?.verifier).toBe("stripe");
  });

  test("bindFromWorkflow updates the row when the trigger payload changes", async () => {
    await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: triggerStripe,
        actor_id: null,
      },
      ctx.db,
    );
    const next = await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: {
          kind: "webhook",
          source: "stripe",
          events: ["invoice.paid", "invoice.payment_failed"],
          verify: "stripe-signature",
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(next.status).toBe("updated");
    const cfg = next.row;
    expect(cfg.verifier).toBe("stripe");
  });

  test("bindFromWorkflow with verify='none' maps to standard verifier with skip flag", async () => {
    const out = await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: {
          kind: "webhook",
          source: "internal",
          events: [],
          verify: "none",
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(out.status).toBe("created");
    expect(out.row.verifier).toBe("standard");
    const dbRows = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(eq(webhooksInbound.id, out.row.id));
    const cfg = dbRows[0]?.native_verifier_config as Record<string, unknown> | null;
    expect(cfg?.skip).toBe(true);
  });

  test("unbindFromWorkflow removes the row + emits WEBHOOK_TRIGGER_UNBOUND", async () => {
    const accountId = deterministicUuid();
    const created = await bindFromWorkflow(
      {
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        workflow_slug: "wf-test",
        trigger: triggerStripe,
        actor_id: null,
      },
      ctx.db,
    );
    const removed = await unbindFromWorkflow(
      ctx.tenantId,
      ctx.workflowId,
      { kind: "system_account", id: accountId },
      ctx.db,
    );
    expect(removed).toBe(1);

    const remaining = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(eq(webhooksInbound.id, created.row.id));
    expect(remaining.length).toBe(0);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "webhook.trigger.unbound")),
      );
    expect(audits.length).toBe(1);
    expect(audits[0]).toMatchObject({ actor_type: "system_account", actor_id: accountId });
  });

  test("unbindFromWorkflow with no prior binding is a no-op (returns 0)", async () => {
    const removed = await unbindFromWorkflow(ctx.tenantId, ctx.workflowId, null, ctx.db);
    expect(removed).toBe(0);
  });
});
