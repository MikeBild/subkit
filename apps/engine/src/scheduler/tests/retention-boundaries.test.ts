import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { markChatEventSeen } from "../../chat/dedup.ts";
import type { Executor } from "../../db/client.ts";
import {
  auditLog,
  chatEventsSeen,
  chatWorkspaces,
  tenants,
  toolApprovals,
} from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { logRing } from "../../observability/log-ring.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runChatDedupCleanup } from "../chat-dedup-cleanup-runner.ts";
import { runToolApprovalsCleanup } from "../tool-approvals-cleanup-runner.ts";

const ids = createDeterministicUuidFactory(0x728162);
const tenantIds = [ids(), ids()] as const;
const workspaceIds = [ids(), ids()] as const;
const now = new Date(getTestNow());
const day = 86_400_000;
const canary = "retention-private-content-canary";
let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("retention_boundaries");
  await ctx.db
    .insert(tenants)
    .values(tenantIds.map((id) => ({ id, slug: id, display_name: "Retention fixture" })));
  await ctx.db.insert(chatWorkspaces).values(
    workspaceIds.map((id, i) => ({
      id,
      tenant_id: tenantIds[i]!,
      platform: "slack" as const,
      workspace_id: id,
      bot_ciphertext: Buffer.from("fixture"),
      bot_iv: Buffer.alloc(12),
      bot_auth_tag: Buffer.alloc(16),
    })),
  );
}, TEST_DB_HOOK_TIMEOUT);
beforeEach(async () => {
  await ctx.db.delete(toolApprovals);
  await ctx.db.delete(chatEventsSeen);
  await ctx.db.delete(auditLog);
  logRing.clear();
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

function approval(consumed: boolean, index = 0) {
  return {
    id: ids(),
    tenant_id: tenantIds[index % 2]!,
    principal_id: ids(),
    tool: canary,
    surface: "http",
    args_ciphertext: Buffer.from(canary),
    args_iv: Buffer.alloc(12),
    args_auth_tag: Buffer.alloc(16),
    args_hash: canary,
    expires_at: sql`now() - interval '2 days'`,
    consumed_at: consumed ? sql`now() - interval '2 days'` : null,
  };
}
function event(key: string, seenAt: Date, index = 0) {
  return {
    tenant_id: tenantIds[index]!,
    workspace_id: workspaceIds[index]!,
    platform_event_id: key,
    seen_at: seenAt,
  };
}
async function count(table: typeof toolApprovals | typeof chatEventsSeen, db: Executor = ctx.db) {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(table);
  return rows[0]!.count;
}
async function audits(action: string) {
  return ctx.db.select().from(auditLog).where(eq(auditLog.action, action));
}
async function failAudit(action: string, body: () => Promise<void>) {
  await ctx.pool.query(
    `CREATE FUNCTION subkit.test_cleanup_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'synthetic_cleanup_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_cleanup_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_cleanup_audit_failure()`,
  );
  try {
    await body();
  } finally {
    await ctx.pool.query(
      "DROP TRIGGER test_cleanup_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_cleanup_audit_failure()",
    );
  }
}
function noCanary(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(canary);
  expect(JSON.stringify(logRing.tail())).not.toContain(canary);
}

test("approval ticks independently drain two multi-page populations with bounded summary audits", async () => {
  await ctx.db
    .insert(toolApprovals)
    .values(Array.from({ length: 1038 }, (_, i) => approval(i >= 519, i)));
  for (const remaining of [526, 14, 0]) {
    await runToolApprovalsCleanup(now, ctx.db);
    expect(await count(toolApprovals)).toBe(remaining);
  }
  const rows = await audits("approval.expired_pruned");
  expect(rows.map((row) => row.metadata)).toEqual(
    [256, 256, 7].map((n) => ({
      request_source: "scheduler",
      sweep: "tool_approvals",
      expired_deleted: n,
      consumed_deleted: n,
    })),
  );
  noCanary(rows);
});

test("approval exact database-time boundaries retain live and recently consumed rows", async () => {
  await ctx.db.transaction(async (tx) => {
    const expired = approval(false);
    const consumed = { ...approval(true), expires_at: sql`now() + interval '1 day'` };
    const edge = { ...approval(false), expires_at: sql`now() - interval '1 day'` };
    const consumedEdge = { ...approval(true), consumed_at: sql`now() - interval '1 day'` };
    const recent = { ...approval(true), consumed_at: sql`now()` };
    const live = {
      ...approval(false, 1),
      expires_at: sql`now() + interval '1 day'`,
      granted_at: sql`now()`,
    };
    await tx.insert(toolApprovals).values([expired, consumed, edge, consumedEdge, recent, live]);
    await runToolApprovalsCleanup(now, tx);
    const rows = await tx.select({ id: toolApprovals.id }).from(toolApprovals);
    expect(rows.map((r) => r.id).sort()).toEqual(
      [edge.id, consumedEdge.id, recent.id, live.id].sort(),
    );
  });
});

test("approval locks skip both populations without blocking and retry next tick", async () => {
  const rows = [approval(false), approval(true), approval(false), approval(true)];
  await ctx.db.insert(toolApprovals).values(rows);
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM subkit.tool_approvals WHERE id=ANY($1::uuid[]) FOR UPDATE", [
      [rows[0]!.id, rows[1]!.id],
    ]);
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='1s'`);
      await runToolApprovalsCleanup(now, tx);
    });
    expect(await count(toolApprovals)).toBe(2);
    expect((await audits("approval.expired_pruned"))[0]?.metadata).toMatchObject({
      expired_deleted: 1,
      consumed_deleted: 1,
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  await runToolApprovalsCleanup(now, ctx.db);
  expect(await count(toolApprovals)).toBe(0);
}, 10_000);

test("approval audit failure rolls back both delete units and emits no private content", async () => {
  await ctx.db.insert(toolApprovals).values([approval(false), approval(true)]);
  await failAudit("approval.expired_pruned", async () => {
    await runToolApprovalsCleanup(now, ctx.db);
    expect(await count(toolApprovals)).toBe(2);
    expect(await audits("approval.expired_pruned")).toHaveLength(0);
    noCanary(logRing.tail());
  });
  await runToolApprovalsCleanup(now, ctx.db);
  expect(await count(toolApprovals)).toBe(0);
});

test("chat ticks drain multi-page cross-tenant backlog and preserve exact replay boundary", async () => {
  await ctx.db
    .insert(chatEventsSeen)
    .values(
      Array.from({ length: 519 }, (_, i) =>
        event(`event-${i}`, new Date(now.getTime() - 2 * day), i % 2),
      ),
    );
  await ctx.db
    .insert(chatEventsSeen)
    .values([event("same-event", new Date(now.getTime() - day)), event("same-event", now, 1)]);
  for (const remaining of [265, 9, 2]) {
    await runChatDedupCleanup(now, ctx.db);
    expect(await count(chatEventsSeen)).toBe(remaining);
  }
  const rows = await audits("chat.dedup.pruned");
  expect(rows.map((row) => (row.metadata as { deleted: number }).deleted)).toEqual([256, 256, 7]);
  for (const index of [0, 1])
    expect(await markChatEventSeen(ctx.db, event("same-event", now, index))).toBe(false);
  await runChatDedupCleanup(new Date(now.getTime() + 1), ctx.db);
  expect(await markChatEventSeen(ctx.db, event("same-event", now))).toBe(true);
  expect(await markChatEventSeen(ctx.db, event("same-event", now, 1))).toBe(false);
});

test("chat locked composite keys remain protected while available expired neighbors are pruned", async () => {
  await ctx.db
    .insert(chatEventsSeen)
    .values([
      event("same-event", new Date(now.getTime() - 2 * day)),
      event("same-event", new Date(now.getTime() - 2 * day), 1),
    ]);
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT workspace_id FROM subkit.chat_events_seen WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE",
      [tenantIds[0], workspaceIds[0]],
    );
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='1s'`);
      await runChatDedupCleanup(now, tx);
    });
    const rows = await ctx.db.select({ tenant_id: chatEventsSeen.tenant_id }).from(chatEventsSeen);
    expect(rows).toEqual([{ tenant_id: tenantIds[0] }]);
    expect((await audits("chat.dedup.pruned"))[0]?.metadata).toMatchObject({ deleted: 1 });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  await runChatDedupCleanup(now, ctx.db);
  expect(await count(chatEventsSeen)).toBe(0);
}, 10_000);

test("chat audit failure rolls back deletion without returning or logging a large event key", async () => {
  await ctx.db
    .insert(chatEventsSeen)
    .values(event(canary + "x".repeat(100_000), new Date(now.getTime() - 2 * day)));
  await failAudit("chat.dedup.pruned", async () => {
    await runChatDedupCleanup(now, ctx.db);
    expect(await count(chatEventsSeen)).toBe(1);
    expect(await audits("chat.dedup.pruned")).toHaveLength(0);
    noCanary(logRing.tail());
  });
  await runChatDedupCleanup(now, ctx.db);
  expect(await count(chatEventsSeen)).toBe(0);
  noCanary(await audits("chat.dedup.pruned"));
});
