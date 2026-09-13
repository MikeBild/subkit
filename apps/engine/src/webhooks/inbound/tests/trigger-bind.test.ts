// Reverse-bind helpers — `bindFromWorkflow` / `unbindFromWorkflow`.
//
// These exercise the schema-foundation portion of reverse-bind.
// Executor logic for webhook firing lives elsewhere; here we only
// confirm that saving a workflow with a `webhook` trigger produces an idempotent
// `webhooks_inbound` row keyed on `(tenant_id, workflow_id)`, that
// repeated saves are no-ops, and that unbind tears the row down with
// the right audit signal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { auditLog, webhooksInbound } from "../../../db/schema/index.ts";
import { bindFromWorkflow, unbindFromWorkflow } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

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

    // Second call with identical trigger is a no-op.
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
    const removed = await unbindFromWorkflow(ctx.tenantId, ctx.workflowId, null, ctx.db);
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
  });

  test("unbindFromWorkflow with no prior binding is a no-op (returns 0)", async () => {
    const removed = await unbindFromWorkflow(ctx.tenantId, ctx.workflowId, null, ctx.db);
    expect(removed).toBe(0);
  });
});
