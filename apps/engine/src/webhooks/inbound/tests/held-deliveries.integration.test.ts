import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { withSystemScope } from "../../../db/index.ts";
import {
  executions,
  webhookHeldDeliveries,
  webhooksInbound,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { recordInboundAdmission } from "../admission-state.ts";
import { HELD_DELIVERY_LIMITS } from "../core/held-delivery.ts";
import { wasSeen } from "../dedup.ts";
import {
  holdSignedDelivery,
  replayHeldDeliveries,
  replayHeldDeliveriesSafely,
  replayHeldDelivery,
  runHeldDeliverySweep,
  settleExpiredHeldDeliveries,
} from "../held-deliveries.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const secret = "held-delivery-integration-signing-key";
let ctx: InboundTestCtx;
let bindingId: string;
let sequence = 0;

beforeEach(async () => {
  ctx = await createInboundCtx(`held-${++sequence}`);
  bindingId = (await ctx.createBinding({ slug: `held-${sequence}`, verifier: "standard", secret }))
    .id;
});
afterEach(async () => {
  await ctx.cleanup();
});

function delivery(id: string, body = '{"invoice":1}', signingKey = secret) {
  const timestamp = Math.floor(getTestNow() / 1000);
  return {
    slug: `held-${sequence}`,
    rawBody: body,
    now: timestamp * 1000,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-type": "invoice.paid",
      "webhook-signature": `v1,${createHmac("sha256", signingKey).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    },
  };
}

const receive = (input: ReturnType<typeof delivery>) =>
  handleInbound({ db: ctx.db, boss: ctx.boss }, input);
const replay = () =>
  replayHeldDeliveries(ctx.db, ctx.boss, { tenant_id: ctx.tenantId, workflow_id: ctx.workflowId });
const heldRows = () =>
  withSystemScope(ctx.db, "test reads held deliveries", (tx) =>
    tx
      .select()
      .from(webhookHeldDeliveries)
      .where(eq(webhookHeldDeliveries.tenant_id, ctx.tenantId))
      .orderBy(webhookHeldDeliveries.delivery_id),
  );
const executionRows = () =>
  ctx.db.select().from(executions).where(eq(executions.tenant_id, ctx.tenantId));

describe("signed deliveries held for approval", () => {
  test("a signed delivery without approval is stored once and replayed into exactly one execution", async () => {
    expect(await receive(delivery("evt-1"))).toEqual({
      status: "held",
      reason: "execution_authority_required",
      inbound_id: bindingId,
    });
    expect(await receive(delivery("evt-1"))).toMatchObject({ status: "held" });
    const [held] = await heldRows();
    expect(await heldRows()).toHaveLength(1);
    expect(held).toMatchObject({
      inbound_id: bindingId,
      workflow_id: ctx.workflowId,
      delivery_id: "evt-1",
      event_type: "invoice.paid",
      state: "held",
      reason_code: "execution_authority_required",
      body_bytes: 13,
      execution_id: null,
    });
    expect(held?.payload).toMatchObject({ body: { invoice: 1 } });
    expect(await executionRows()).toHaveLength(0);

    await ctx.grantAuthority("prod", 5);
    expect(await replay()).toEqual({ skipped: 0, replayed: 1, held: 0, failed: 0 });
    expect(await replay()).toEqual({ skipped: 0, replayed: 0, held: 0, failed: 0 });
    const runs = await executionRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ request_source: "webhook", status: "queued" });
    const [settled] = await heldRows();
    expect(settled).toMatchObject({ state: "replayed", execution_id: runs[0]?.id });
    expect(settled?.settled_at).not.toBeNull();
    expect(
      await wasSeen(ctx.db, {
        tenant_id: ctx.tenantId,
        webhook_id: bindingId,
        standard_webhook_id: "evt-1",
      }),
    ).toBe(true);
    expect(await receive(delivery("evt-1"))).toMatchObject({ status: "deduped" });
    expect(await executionRows()).toHaveLength(1);
  });

  test("concurrent replays claim each held delivery once", async () => {
    await receive(delivery("evt-a", '{"n":1}'));
    await receive(delivery("evt-b", '{"n":2}'));
    await ctx.grantAuthority("prod", 5);
    const ids = (await heldRows()).map((row) => row.id);
    const outcomes = await Promise.all(
      ids.flatMap((id) => [
        replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, id),
        replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, id),
      ]),
    );
    expect(outcomes.filter((outcome) => outcome === "replayed")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(2);
    expect(await executionRows()).toHaveLength(2);
  });

  test("a delivery admitted by a sender redelivery is settled on replay without a second execution", async () => {
    await receive(delivery("evt-r"));
    await ctx.grantAuthority("prod", 5);
    expect(await receive(delivery("evt-r"))).toMatchObject({ status: "ok" });
    expect(await replay()).toMatchObject({ replayed: 1 });
    expect(await executionRows()).toHaveLength(1);
    expect((await heldRows())[0]?.execution_id).toBe((await executionRows())[0]?.id);
  });

  test("an unverified delivery is rejected and never stored", async () => {
    expect(await receive(delivery("evt-bad", '{"invoice":1}', "wrong-key"))).toMatchObject({
      status: "denied",
    });
    expect(await heldRows()).toHaveLength(0);
  });

  test("an unsigned hook keeps the refusal and stores nothing", async () => {
    await ctx.db
      .update(webhooksInbound)
      .set({ native_verifier_config: { skip: true } })
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, bindingId)));
    expect(await receive(delivery("evt-unsigned"))).toMatchObject({
      status: "denied",
      reason: "execution_authority_required",
    });
    expect(await heldRows()).toHaveLength(0);
  });

  test("a full hook and an oversized body are refused without storing", async () => {
    const oversized = `{"blob":"${"x".repeat(HELD_DELIVERY_LIMITS.max_body_bytes)}"}`;
    expect(await receive(delivery("evt-big", oversized))).toMatchObject({
      status: "denied",
      reason: "held_delivery_too_large",
    });
    await withSystemScope(ctx.db, "test fills the hook", (tx) =>
      tx.insert(webhookHeldDeliveries).values(
        Array.from({ length: HELD_DELIVERY_LIMITS.per_hook }, (_, index) => ({
          tenant_id: ctx.tenantId,
          inbound_id: bindingId,
          workflow_id: ctx.workflowId,
          delivery_id: `filler-${index}`,
          event_type: "invoice.paid",
          payload: {},
          body_bytes: 2,
          reason_code: "execution_authority_required",
          expires_at: sql`clock_timestamp() + interval '1 hour'`,
        })),
      ),
    );
    expect(await receive(delivery("evt-over"))).toMatchObject({
      status: "denied",
      reason: "held_delivery_over_capacity",
    });
    const stored = (await heldRows()).map((row) => row.delivery_id);
    expect(stored).not.toContain("evt-over");
    expect(stored).not.toContain("evt-big");
  });

  const fillHook = (count: number) =>
    withSystemScope(ctx.db, "test fills the hook", (tx) =>
      tx.insert(webhookHeldDeliveries).values(
        Array.from({ length: count }, (_, index) => ({
          tenant_id: ctx.tenantId,
          inbound_id: bindingId,
          workflow_id: ctx.workflowId,
          delivery_id: `filler-${index}`,
          event_type: "invoice.paid",
          payload: {},
          body_bytes: 2,
          reason_code: "execution_authority_required",
          expires_at: sql`clock_timestamp() + interval '1 hour'`,
        })),
      ),
    );

  test("a full hook still answers a redelivery of a stored id as held and refuses a new id", async () => {
    expect(await receive(delivery("evt-first"))).toMatchObject({ status: "held" });
    await fillHook(HELD_DELIVERY_LIMITS.per_hook - 1);
    expect(await receive(delivery("evt-first"))).toEqual({
      status: "held",
      reason: "execution_authority_required",
      inbound_id: bindingId,
    });
    expect(await receive(delivery("evt-new"))).toMatchObject({
      status: "denied",
      reason: "held_delivery_over_capacity",
    });
    const stored = (await heldRows()).map((row) => row.delivery_id);
    expect(stored.filter((id) => id === "evt-first")).toHaveLength(1);
    expect(stored).not.toContain("evt-new");
    expect(stored).toHaveLength(HELD_DELIVERY_LIMITS.per_hook);
  });

  test("a held id redelivered with a different body is refused like a live boundary mismatch", async () => {
    expect(await receive(delivery("evt-same", '{"invoice":1}'))).toMatchObject({ status: "held" });
    const [before] = await heldRows();
    expect(await receive(delivery("evt-same", '{"invoice":1}'))).toMatchObject({ status: "held" });
    expect(await receive(delivery("evt-same", '{"invoice":2}'))).toMatchObject({
      status: "denied",
      reason: "execution_boundary_mismatch",
      inbound_id: bindingId,
    });
    await fillHook(HELD_DELIVERY_LIMITS.per_hook - 1);
    expect(await receive(delivery("evt-same", '{"invoice":3}'))).toMatchObject({
      reason: "execution_boundary_mismatch",
    });
    const after = (await heldRows()).filter((row) => row.delivery_id === "evt-same");
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before as NonNullable<typeof before>);
    await ctx.grantAuthority("prod", 5);
    expect(await receive(delivery("evt-same", '{"invoice":2}'))).toMatchObject({
      status: "denied",
      reason: "execution_boundary_mismatch",
    });
  });

  test("a different body that reaches the store after admission still loses to the held row", async () => {
    await receive(delivery("evt-late"));
    const [stored] = await heldRows();
    const [hook] = await withSystemScope(ctx.db, "test reads the hook", (tx) =>
      tx.select().from(webhooksInbound).where(eq(webhooksInbound.id, bindingId)),
    );
    if (!stored || !hook) throw new Error("missing held delivery");
    const arrival = (payload: unknown) =>
      holdSignedDelivery(ctx.db, {
        hook,
        version_id: hook.workflow_id,
        delivery: { id: "evt-late", type: "invoice.paid" },
        payload,
        body_bytes: 13,
        reason_code: "execution_authority_required",
      });
    expect(await arrival(stored.payload)).toEqual({ status: "held", duplicate: true });
    expect(
      await arrival({ ...(stored.payload as Record<string, unknown>), body: { invoice: 9 } }),
    ).toEqual({ status: "mismatch" });
    expect(await heldRows()).toEqual([stored]);
  });

  test("concurrent arrivals of one delivery store a single row and all answer held", async () => {
    const answers = await Promise.all(
      Array.from({ length: 4 }, () => receive(delivery("evt-race"))),
    );
    for (const answer of answers) expect(answer).toMatchObject({ status: "held" });
    expect(await heldRows()).toHaveLength(1);
  });

  test("concurrent new ids at the last free slot store exactly one", async () => {
    await fillHook(HELD_DELIVERY_LIMITS.per_hook - 1);
    const answers = await Promise.all([receive(delivery("evt-x")), receive(delivery("evt-y"))]);
    expect(answers.map((answer) => answer.status).sort()).toEqual(["denied", "held"]);
    expect(await heldRows()).toHaveLength(HELD_DELIVERY_LIMITS.per_hook);
  });

  test("an expired delivery is settled by the sweep and never replayed", async () => {
    await receive(delivery("evt-old"));
    await withSystemScope(ctx.db, "test ages the delivery", (tx) =>
      tx
        .update(webhookHeldDeliveries)
        .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(webhookHeldDeliveries.tenant_id, ctx.tenantId)),
    );
    await ctx.grantAuthority("prod", 5);
    expect(await replay()).toEqual({ skipped: 0, replayed: 0, held: 0, failed: 0 });
    expect(await settleExpiredHeldDeliveries(ctx.db)).toBe(1);
    expect((await heldRows())[0]?.state).toBe("expired");
    expect(await receive(delivery("evt-old"))).toMatchObject({ status: "ok" });
    await withSystemScope(ctx.db, "test ages the settlement", (tx) =>
      tx
        .update(webhookHeldDeliveries)
        .set({ settled_at: sql`clock_timestamp() - interval '400 hours'` })
        .where(eq(webhookHeldDeliveries.tenant_id, ctx.tenantId)),
    );
    await settleExpiredHeldDeliveries(ctx.db);
    expect(await heldRows()).toHaveLength(0);
  });

  test("a redelivery of a settled delivery while still held keeps the refusal", async () => {
    await receive(delivery("evt-gone"));
    await withSystemScope(ctx.db, "test ages the delivery", (tx) =>
      tx
        .update(webhookHeldDeliveries)
        .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(webhookHeldDeliveries.tenant_id, ctx.tenantId)),
    );
    await settleExpiredHeldDeliveries(ctx.db);
    expect(await receive(delivery("evt-gone"))).toMatchObject({
      status: "denied",
      reason: "execution_authority_required",
    });
  });

  test("without approval the replay keeps the delivery held", async () => {
    await receive(delivery("evt-wait"));
    expect(await replay()).toEqual({ skipped: 0, replayed: 0, held: 1, failed: 0 });
    expect((await heldRows())[0]?.state).toBe("held");
  });

  test("a deactivated hook settles its held delivery as replay_failed", async () => {
    await receive(delivery("evt-off"));
    await ctx.grantAuthority("prod", 5);
    await ctx.db
      .update(webhooksInbound)
      .set({ active: false })
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, bindingId)));
    expect(await replay()).toEqual({ skipped: 0, replayed: 0, held: 0, failed: 1 });
    expect((await heldRows())[0]).toMatchObject({
      state: "replay_failed",
      outcome_code: "inactive",
    });
    expect(await executionRows()).toHaveLength(0);
  });

  test("an archived workflow settles its held delivery as replay_failed", async () => {
    await receive(delivery("evt-archived"));
    await ctx.grantAuthority("prod", 5);
    await ctx.db
      .update(workflows)
      .set({ lifecycle: "archived" })
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, ctx.workflowId)));
    expect(await replay()).toMatchObject({ failed: 1 });
    expect((await heldRows())[0]).toMatchObject({
      state: "replay_failed",
      outcome_code: "workflow_inactive",
    });
  });

  test("the sweep replays once the hook hold is released", async () => {
    await ctx.db
      .update(webhooksInbound)
      .set({ origin: "trigger" })
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, bindingId)));
    await receive(delivery("evt-sweep"));
    await ctx.grantAuthority("prod", 5);
    await runHeldDeliverySweep(ctx.db, ctx.boss);
    expect((await heldRows())[0]?.state).toBe("held");
    await recordInboundAdmission(
      ctx.db,
      { tenant_id: ctx.tenantId, inbound_id: bindingId, observed_at: new Date(getTestNow()) },
      null,
    );
    await runHeldDeliverySweep(ctx.db, ctx.boss);
    expect((await heldRows())[0]?.state).toBe("replayed");
    expect(await executionRows()).toHaveLength(1);
  });

  test("a sensitive workflow keeps the held payload encrypted and still replays it", async () => {
    await ctx.db
      .update(workflowVersions)
      .set({
        dag: sql`${workflowVersions.dag} || '{"execution_privacy":"sensitive"}'::jsonb`,
      })
      .where(eq(workflowVersions.tenant_id, ctx.tenantId));
    await receive(delivery("evt-secret", '{"card":"4242"}'));
    const [held] = await heldRows();
    expect(held?.payload).toMatchObject({ $sensitive: true });
    expect(JSON.stringify(held?.payload)).not.toContain("4242");
    await ctx.grantAuthority("prod", 5);
    expect(await replay()).toMatchObject({ replayed: 1 });
    expect(await executionRows()).toHaveLength(1);
  });

  test("a replay that cannot reach the queue leaves the delivery for the sweep", async () => {
    await receive(delivery("evt-later"));
    await replayHeldDeliveriesSafely(
      ctx.db,
      () => {
        throw new Error("queue unavailable");
      },
      { tenant_id: ctx.tenantId, workflow_id: ctx.workflowId },
    );
    expect((await heldRows())[0]?.state).toBe("held");
  });

  test("held deliveries are row scoped and forced", async () => {
    const result = await ctx.db.execute<{ forced: boolean }>(
      sql`SELECT relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE oid = 'subkit.webhook_held_deliveries'::regclass`,
    );
    expect(result.rows[0]?.forced).toBe(true);
  });
});
