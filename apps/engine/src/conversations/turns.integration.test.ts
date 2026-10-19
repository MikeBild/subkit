import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations, conversationTurns, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { cancelConversationAbort } from "./abort.ts";
import {
  acquireConversationTurn,
  assertConversationTurn,
  bindConversationTurn,
  ConversationTurnInProgressError,
  cancelConversationTurns,
  conversationTurnId,
  finishConversationTurn,
  parkConversationTurn,
  releaseConversationTurn,
  reserveConversationTurn,
  stopConversationTaskTurn,
  withReservedConversationTurn,
} from "./turns.ts";

let ctx: TestDb;
let tenant: string;
const attempt = "00000000-0000-4000-8000-000000000001";
const otherAttempt = "00000000-0000-4000-8000-000000000002";
const task = "00000000-0000-4000-8000-000000000003";

beforeAll(async () => {
  ctx = await createTestDb("conversation_turns");
  const [row] = await ctx.db
    .insert(tenants)
    .values({ slug: "turns", display_name: "Turns" })
    .returning();
  if (!row) throw new Error("missing tenant");
  tenant = row.id;
});
afterAll(async () => {
  await ctx?.cleanup();
});

async function conversation() {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: tenant, status: "active" })
    .returning();
  if (!row) throw new Error("missing conversation");
  return row.id;
}

test("concurrent admissions accept exactly one operation before either can write a message", async () => {
  const id = await conversation();
  const results = await Promise.allSettled([
    reserveConversationTurn(ctx.db, tenant, id),
    reserveConversationTurn(ctx.db, tenant, id),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const failed = results.find((result) => result.status === "rejected");
  expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(
    ConversationTurnInProgressError,
  );
  const [row] = await ctx.db
    .select()
    .from(conversationTurns)
    .where(and(eq(conversationTurns.tenant_id, tenant), eq(conversationTurns.conversation_id, id)));
  if (!row) throw new Error("missing admission");
  await finishConversationTurn(ctx.db, tenant, id, row.id);
});

test("another conversation can run concurrently and cancellation reaches its own controller", async () => {
  const a = await conversation();
  const b = await conversation();
  const first = await acquireConversationTurn(tenant, a, ctx.db);
  const second = await acquireConversationTurn(tenant, b, ctx.db);
  try {
    await expect(acquireConversationTurn(tenant, a, ctx.db)).rejects.toBeInstanceOf(
      ConversationTurnInProgressError,
    );
    expect(cancelConversationAbort(tenant, a)).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  } finally {
    await releaseConversationTurn(tenant, a, first);
    await releaseConversationTurn(tenant, b, second);
  }
});

test("parked retries retain admission and reject stale attempts", async () => {
  const id = await conversation();
  const turn = await reserveConversationTurn(ctx.db, tenant, id);
  await bindConversationTurn(ctx.db, tenant, id, turn, task, attempt);
  const ctrl = await acquireConversationTurn(tenant, id, ctx.db, {
    turn_id: turn,
    attempt_id: attempt,
  });
  expect(conversationTurnId(ctrl)).toBe(turn);
  await parkConversationTurn(tenant, id, ctrl);
  await bindConversationTurn(ctx.db, tenant, id, turn, task, otherAttempt, attempt);
  await expect(acquireConversationTurn(tenant, id, ctx.db)).rejects.toBeInstanceOf(
    ConversationTurnInProgressError,
  );
  await expect(
    acquireConversationTurn(tenant, id, ctx.db, { turn_id: turn, attempt_id: attempt }),
  ).rejects.toBeInstanceOf(ConversationTurnInProgressError);
  const retry = await acquireConversationTurn(tenant, id, ctx.db, {
    turn_id: turn,
    attempt_id: otherAttempt,
  });
  await releaseConversationTurn(tenant, id, ctrl);
  await expect(acquireConversationTurn(tenant, id, ctx.db)).rejects.toBeInstanceOf(
    ConversationTurnInProgressError,
  );
  await releaseConversationTurn(tenant, id, retry);
  const next = await acquireConversationTurn(tenant, id, ctx.db);
  await releaseConversationTurn(tenant, id, next);
});

test("a rejected enqueue releases its reservation and records its terminal transition", async () => {
  const id = await conversation();
  await withReservedConversationTurn(ctx.db, tenant, id, async () => ({ isError: true }));
  const next = await acquireConversationTurn(tenant, id, ctx.db);
  await releaseConversationTurn(tenant, id, next);
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant), eq(auditLog.resource_id, id)));
  expect(rows.some((row) => (row.metadata as { state?: string }).state === "failed")).toBe(true);
});

test("a foreign tenant cannot reserve or resume a conversation", async () => {
  const id = await conversation();
  const foreign = "00000000-0000-4000-8000-000000000099";
  await expect(reserveConversationTurn(ctx.db, foreign, id)).rejects.toThrow(
    "conversation not found",
  );
});

test("a remote cancellation fences the running turn until its owner exits", async () => {
  const id = await conversation();
  const ctrl = await acquireConversationTurn(tenant, id, ctx.db);
  await cancelConversationTurns(ctx.db, tenant, id);
  await expect(assertConversationTurn(ctrl.signal)).rejects.toBe("conversation_cancelled");
  await expect(acquireConversationTurn(tenant, id, ctx.db)).rejects.toBeInstanceOf(
    ConversationTurnInProgressError,
  );
  await releaseConversationTurn(tenant, id, ctrl);
  const next = await acquireConversationTurn(tenant, id, ctx.db);
  await releaseConversationTurn(tenant, id, next);
});

test("worker recovery requires the actual session lock to disappear and never replays its task", async () => {
  const id = await conversation();
  const ctrl = await acquireConversationTurn(tenant, id, ctx.db);
  const turnId = conversationTurnId(ctrl);
  await expect(reserveConversationTurn(ctx.db, tenant, id)).rejects.toBeInstanceOf(
    ConversationTurnInProgressError,
  );
  await ctx.pool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'subkit-conversation-turn'",
  );
  await waitFor(() => ctrl.signal.aborted, {
    label: "interrupted worker observes its lost session",
    tries: 100,
    sleepMs: 5,
  });
  const next = await reserveConversationTurn(ctx.db, tenant, id);
  const [interrupted] = await ctx.db
    .select()
    .from(conversationTurns)
    .where(and(eq(conversationTurns.tenant_id, tenant), eq(conversationTurns.id, turnId ?? "")));
  expect(interrupted?.state).toBe("failed");
  await releaseConversationTurn(tenant, id, ctrl);
  await finishConversationTurn(ctx.db, tenant, id, next);
});

test("dead-lettered reservations release only their matching attempt and fence a live owner", async () => {
  const id = await conversation();
  const turn = await reserveConversationTurn(ctx.db, tenant, id);
  await bindConversationTurn(ctx.db, tenant, id, turn, task, attempt);
  await stopConversationTaskTurn(ctx.db, tenant, id, turn, task, otherAttempt);
  await expect(reserveConversationTurn(ctx.db, tenant, id)).rejects.toBeInstanceOf(
    ConversationTurnInProgressError,
  );
  await stopConversationTaskTurn(ctx.db, tenant, id, turn, task, attempt);
  const next = await reserveConversationTurn(ctx.db, tenant, id);
  await bindConversationTurn(ctx.db, tenant, id, next, task, otherAttempt);
  const ctrl = await acquireConversationTurn(tenant, id, ctx.db, {
    turn_id: next,
    attempt_id: otherAttempt,
  });
  await stopConversationTaskTurn(ctx.db, tenant, id, turn, task, attempt);
  await assertConversationTurn(ctrl.signal);
  await stopConversationTaskTurn(ctx.db, tenant, id, next, task, otherAttempt);
  await expect(assertConversationTurn(ctrl.signal)).rejects.toBe("conversation_cancelled");
  await expect(reserveConversationTurn(ctx.db, tenant, id)).rejects.toBeInstanceOf(
    ConversationTurnInProgressError,
  );
  await releaseConversationTurn(tenant, id, ctrl);
  const released = await reserveConversationTurn(ctx.db, tenant, id);
  await finishConversationTurn(ctx.db, tenant, id, released);
});
