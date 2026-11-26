import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss, SendOptions } from "pg-boss";
import { withSystemScope } from "../../../db/index.ts";
import {
  executions,
  webhookHeldDeliveries,
  webhooksInbound,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { EXECUTION_RUN_QUEUE } from "../../../queue/queues.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { recordInboundAdmission } from "../admission-state.ts";
import {
  reclaimLapsedHeldReplays,
  replayHeldDeliveries,
  replayHeldDelivery,
  runHeldDeliverySweep,
  settleExpiredHeldDeliveries,
} from "../held-deliveries.ts";
import { claimHeldDelivery } from "../persistence/held-deliveries.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const secret = "held-replay-enqueue-signing-key";
let ctx: InboundTestCtx;
let bindingId: string;
let sequence = 0;

beforeEach(async () => {
  ctx = await createInboundCtx(`held-enqueue-${++sequence}`);
  bindingId = (
    await ctx.createBinding({ slug: `held-enqueue-${sequence}`, verifier: "standard", secret })
  ).id;
});
afterEach(async () => {
  await ctx.cleanup();
});

function delivery(id: string, body = '{"invoice":1}') {
  const timestamp = Math.floor(getTestNow() / 1000);
  return {
    slug: `held-enqueue-${sequence}`,
    rawBody: body,
    now: timestamp * 1000,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-type": "invoice.paid",
      "webhook-signature": `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    },
  };
}

const scope = () => ({ tenant_id: ctx.tenantId, workflow_id: ctx.workflowId });
const heldRows = () =>
  withSystemScope(ctx.db, "test reads held deliveries", (tx) =>
    tx
      .select()
      .from(webhookHeldDeliveries)
      .where(eq(webhookHeldDeliveries.tenant_id, ctx.tenantId)),
  );
const executionRows = () =>
  ctx.db.select().from(executions).where(eq(executions.tenant_id, ctx.tenantId));
const lapseClaims = () =>
  withSystemScope(ctx.db, "test lapses the replay claim", (tx) =>
    tx
      .update(webhookHeldDeliveries)
      .set({ claimed_until: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(webhookHeldDeliveries.state, "replaying")),
  );

type Send = (name: string, data?: object | null, options?: SendOptions) => Promise<string | null>;

function bossWithSend(send: (original: Send) => Send): PgBoss {
  const original: Send = (name, data, options) => ctx.boss.send(name, data, options);
  return new Proxy(ctx.boss, {
    get: (target, property, receiver) =>
      property === "send" ? send(original) : Reflect.get(target, property, receiver),
  });
}

async function holdApproved(id: string) {
  await handleInbound({ db: ctx.db, boss: ctx.boss }, delivery(id));
  await ctx.grantAuthority("prod", 5);
  const [held] = await heldRows();
  if (!held) throw new Error("missing held delivery");
  return held;
}

describe("held delivery replay reaches the run queue before it settles", () => {
  test("a failed enqueue returns the delivery to held and the retry queues exactly one run", async () => {
    const held = await holdApproved("evt-queue-down");
    const failing = bossWithSend(() => async () => {
      throw new Error("queue unavailable");
    });
    expect(await replayHeldDeliveries(ctx.db, failing, scope())).toEqual({
      skipped: 0,
      replayed: 0,
      held: 1,
      failed: 0,
    });
    const [returned] = await heldRows();
    expect(returned).toMatchObject({ state: "held", claim_token: null, claimed_until: null });
    expect(returned?.settled_at).toBeNull();
    const [orphan] = await executionRows();
    expect(orphan).toMatchObject({ status: "queued" });
    expect(await ctx.boss.getJobById(EXECUTION_RUN_QUEUE, orphan?.id ?? "")).toBeNull();

    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("replayed");
    const runs = await executionRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(orphan?.id ?? "");
    expect(await ctx.boss.getJobById(EXECUTION_RUN_QUEUE, orphan?.id ?? "")).toMatchObject({
      id: orphan?.id,
    });
    const [settled] = await heldRows();
    expect(settled).toMatchObject({
      state: "replayed",
      execution_id: orphan?.id,
      claim_token: null,
    });
    expect(settled?.settled_at).not.toBeNull();
    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("skipped");
  });

  test("a claim that lapses before its enqueue is reclaimed by the sweep and replayed once", async () => {
    const held = await holdApproved("evt-crashed");
    const claimed = await claimHeldDelivery(ctx.db, ctx.tenantId, held.id);
    expect(claimed).toMatchObject({ state: "replaying" });
    expect(await claimHeldDelivery(ctx.db, ctx.tenantId, held.id)).toBeNull();
    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("skipped");
    expect(await reclaimLapsedHeldReplays(ctx.db)).toBe(0);
    await lapseClaims();
    await recordInboundAdmission(
      ctx.db,
      { tenant_id: ctx.tenantId, inbound_id: bindingId, observed_at: new Date(getTestNow()) },
      null,
    );
    await runHeldDeliverySweep(ctx.db, ctx.boss);
    const [settled] = await heldRows();
    expect(settled).toMatchObject({ state: "replayed", claim_token: null });
    const runs = await executionRows();
    expect(runs).toHaveLength(1);
    expect(settled?.execution_id).toBe(runs[0]?.id ?? "");
  });

  test("a replay whose lapsed claim was taken over settles once without a second run", async () => {
    const held = await holdApproved("evt-overtaken");
    const overtaking = bossWithSend((original) => async (name, data, options) => {
      await lapseClaims();
      expect(await reclaimLapsedHeldReplays(ctx.db)).toBe(1);
      expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("replayed");
      return original(name, data, options);
    });
    expect(await replayHeldDelivery(ctx.db, overtaking, ctx.tenantId, held.id)).toBe("skipped");
    expect(await executionRows()).toHaveLength(1);
    expect((await heldRows())[0]).toMatchObject({ state: "replayed", claim_token: null });
  });
});

const failingBoss = () =>
  bossWithSend(() => async () => {
    throw new Error("queue unavailable");
  });

async function heldWithOrphan(id: string) {
  const held = await holdApproved(id);
  expect(await replayHeldDelivery(ctx.db, failingBoss(), ctx.tenantId, held.id)).toBe("held");
  const [orphan] = await executionRows();
  if (!orphan) throw new Error("missing admitted execution");
  expect((await heldRows())[0]).toMatchObject({ state: "held", execution_id: orphan.id });
  return { held, orphan };
}

async function publishNextVersion() {
  const [current] = await ctx.db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflow_id, ctx.workflowId));
  if (!current) throw new Error("missing workflow version");
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: ctx.tenantId, workflow_id: ctx.workflowId, version: 2, dag: current.dag })
    .returning();
  if (!next) throw new Error("missing next version");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: next.id })
    .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, ctx.workflowId)));
  return { original: current.id, next: next.id };
}

const setOrphanStatus = (id: string, status: "running" | "aborted") =>
  ctx.db.update(executions).set({ status }).where(eq(executions.id, id));

describe("a held replay resumes the execution it already admitted", () => {
  test("after a version change the retry enqueues the original execution and admits nothing new", async () => {
    const { held, orphan } = await heldWithOrphan("evt-version");
    const versions = await publishNextVersion();
    expect(orphan.workflow_version_id).toBe(versions.original);
    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("replayed");
    const runs = await executionRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: orphan.id, workflow_version_id: versions.original });
    expect(await ctx.boss.getJobById(EXECUTION_RUN_QUEUE, orphan.id)).toMatchObject({
      id: orphan.id,
    });
    expect((await heldRows())[0]).toMatchObject({ state: "replayed", execution_id: orphan.id });
  });

  test("an execution that already left the queue settles the delivery without enqueueing", async () => {
    const { held, orphan } = await heldWithOrphan("evt-running");
    await setOrphanStatus(orphan.id, "running");
    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("replayed");
    expect(await executionRows()).toHaveLength(1);
    expect(await ctx.boss.getJobById(EXECUTION_RUN_QUEUE, orphan.id)).toBeNull();
    expect((await heldRows())[0]).toMatchObject({ state: "replayed", execution_id: orphan.id });
  });

  test("an aborted execution fails the delivery instead of admitting a second run", async () => {
    const { held, orphan } = await heldWithOrphan("evt-aborted");
    await setOrphanStatus(orphan.id, "aborted");
    await ageDeliveries();
    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("failed");
    expect(await executionRows()).toHaveLength(1);
    expect((await heldRows())[0]).toMatchObject({
      state: "replay_failed",
      outcome_code: "execution_aborted",
      execution_id: orphan.id,
    });
  });

  test("a vanished execution fails the delivery instead of admitting a second run", async () => {
    const { held } = await heldWithOrphan("evt-missing");
    const missing = "00000000-0000-4000-8000-000000000927";
    await withSystemScope(ctx.db, "test points the delivery at a vanished execution", (tx) =>
      tx
        .update(webhookHeldDeliveries)
        .set({ execution_id: missing })
        .where(eq(webhookHeldDeliveries.id, held.id)),
    );
    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("failed");
    expect(await executionRows()).toHaveLength(1);
    expect((await heldRows())[0]).toMatchObject({
      state: "replay_failed",
      outcome_code: "execution_missing",
      execution_id: missing,
    });
  });
});

const ageDeliveries = () =>
  withSystemScope(ctx.db, "test lets the held deliveries outlive their ttl", (tx) =>
    tx
      .update(webhookHeldDeliveries)
      .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(webhookHeldDeliveries.tenant_id, ctx.tenantId)),
  );
const deleteHook = () =>
  withSystemScope(ctx.db, "test deletes the hook", (tx) =>
    tx.delete(webhooksInbound).where(eq(webhooksInbound.id, bindingId)),
  );

describe("an admitted held delivery is resumed until its run is queued", () => {
  test("after its ttl the sweep enqueues the recorded execution instead of expiring it", async () => {
    const { orphan } = await heldWithOrphan("evt-ttl");
    await ageDeliveries();
    expect(await settleExpiredHeldDeliveries(ctx.db)).toBe(0);
    expect((await heldRows())[0]).toMatchObject({ state: "held", execution_id: orphan.id });
    await runHeldDeliverySweep(ctx.db, ctx.boss);
    expect((await heldRows())[0]).toMatchObject({ state: "replayed", execution_id: orphan.id });
    expect(await executionRows()).toHaveLength(1);
    expect(await ctx.boss.getJobById(EXECUTION_RUN_QUEUE, orphan.id)).toMatchObject({
      id: orphan.id,
    });
  });

  test("a deleted hook keeps the admitted delivery so the sweep still enqueues it", async () => {
    const { orphan } = await heldWithOrphan("evt-unhooked");
    await deleteHook();
    expect((await heldRows())[0]).toMatchObject({ inbound_id: null, execution_id: orphan.id });
    await runHeldDeliverySweep(ctx.db, ctx.boss);
    expect((await heldRows())[0]).toMatchObject({ state: "replayed", execution_id: orphan.id });
    expect(await ctx.boss.getJobById(EXECUTION_RUN_QUEUE, orphan.id)).toMatchObject({
      id: orphan.id,
    });
  });

  test("a delivery never admitted fails as inactive once its hook is deleted", async () => {
    const held = await holdApproved("evt-hookless");
    await deleteHook();
    expect(await replayHeldDelivery(ctx.db, ctx.boss, ctx.tenantId, held.id)).toBe("failed");
    expect((await heldRows())[0]).toMatchObject({
      state: "replay_failed",
      outcome_code: "inactive",
      inbound_id: null,
      execution_id: null,
    });
    expect(await executionRows()).toHaveLength(0);
  });
});
