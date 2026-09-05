import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction, ToolPolicyChangedMetadataSchema } from "../audit/types.ts";
import { auditLog, conversations, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { getToolPolicies, setToolPolicy, type ToolPolicyAuditCtx } from "./tool-policies.ts";

const AUDIT: ToolPolicyAuditCtx = {
  actor_type: "system",
  actor_id: null,
  request_source: "ui",
};

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("tool_policy_concurrency");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "policy-concurrency", display_name: "Policy concurrency" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function newConversation(tool_policies: Record<string, string> = {}): Promise<string> {
  const [conversation] = await testDb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active", tool_policies })
    .returning();
  if (!conversation) throw new Error("conversation insert failed");
  return conversation.id;
}

/** Hold the row until BOTH writers are waiting in PostgreSQL. With the old
 * unlocked SELECT both would have read the same JSONB before their UPDATE
 * blocked. Release in finally, before awaiting the writers, so even a failed
 * assertion cannot strand their transactions or the pool's teardown. */
async function racePolicies(conversationId: string, writes: (() => Promise<void>)[]) {
  const blocker = await testDb.pool.connect();
  let outcomes: Promise<PromiseSettledResult<void>[]> | undefined;
  let results: PromiseSettledResult<void>[] = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, conversationId],
    );
    outcomes = Promise.allSettled(writes.map((write) => write()));
    await waitFor(
      async () => {
        const { rows } = await testDb.pool.query<{ waiting: number }>(
          `SELECT count(*)::integer AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query LIKE '%conversations%' AND pid <> pg_backend_pid()`,
        );
        return rows[0]?.waiting === writes.length;
      },
      { label: "concurrent policy writers waiting on the held row", tries: 200, sleepMs: 5 },
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (outcomes) results = await outcomes;
  }
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

async function policyAudits(conversationId: string) {
  return testDb.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.resource_id, conversationId),
        eq(auditLog.action, AuditAction.TOOL_POLICY_CHANGED),
      ),
    );
}

describe("tool-policy decisions serialize without losing independent bounds", () => {
  test("parallel edits preserve both keys and both audit entries", async () => {
    const id = await newConversation();
    await racePolicies(id, [
      () =>
        setToolPolicy(testDb.db, tenantId, id, "run_workflow", "confirm_before_execution", AUDIT),
      () =>
        setToolPolicy(
          testDb.db,
          tenantId,
          id,
          "delete_workflow",
          "confirm_before_execution",
          AUDIT,
        ),
    ]);
    expect(await getToolPolicies(testDb.db, tenantId, id)).toEqual({
      run_workflow: "confirm_before_execution",
      delete_workflow: "confirm_before_execution",
    });
    const rows = await policyAudits(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        {
          tool: "run_workflow",
          prior_mode: null,
          mode: "confirm_before_execution",
          request_source: "ui",
        },
        {
          tool: "delete_workflow",
          prior_mode: null,
          mode: "confirm_before_execution",
          request_source: "ui",
        },
      ]),
    );
  });

  test("clearing one override cannot undo another simultaneous edit", async () => {
    const id = await newConversation({ run_workflow: "no_confirm" });
    await racePolicies(id, [
      () => setToolPolicy(testDb.db, tenantId, id, "run_workflow", null, AUDIT),
      () =>
        setToolPolicy(
          testDb.db,
          tenantId,
          id,
          "delete_workflow",
          "confirm_before_execution",
          AUDIT,
        ),
    ]);
    expect(await getToolPolicies(testDb.db, tenantId, id)).toEqual({
      delete_workflow: "confirm_before_execution",
    });
    expect((await policyAudits(id)).map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        { tool: "run_workflow", prior_mode: "no_confirm", mode: null, request_source: "ui" },
      ]),
    );
  });

  test("same-key edits audit the serialized predecessor, not a stale snapshot", async () => {
    const id = await newConversation();
    await racePolicies(id, [
      () => setToolPolicy(testDb.db, tenantId, id, "run_workflow", "no_confirm", AUDIT),
      () =>
        setToolPolicy(testDb.db, tenantId, id, "run_workflow", "confirm_before_execution", AUDIT),
    ]);
    const rows = (await policyAudits(id)).map((row) =>
      ToolPolicyChangedMetadataSchema.parse(row.metadata),
    );
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.prior_mode === null);
    const second = rows.find((row) => row.prior_mode !== null);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.prior_mode).toBe(first?.mode);
    expect((await getToolPolicies(testDb.db, tenantId, id)).run_workflow).toBe(
      second?.mode ?? undefined,
    );
  });
});
