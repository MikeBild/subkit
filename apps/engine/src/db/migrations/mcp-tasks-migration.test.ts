// 0026_mcp_tasks migration — table shape + FK cascade (integration).
//
// `createTestDb` runs the full embedded migration bundle, so a fresh
// test database already has `mcp_tasks`. This test pins:
//   - the table exists with the documented columns,
//   - `conversation_id` cascades on conversation delete (the index row
//     must not outlive its conversation),
//   - the (tenant, conversation, turn_seq) and (tenant, created_at)
//     indexes exist.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { conversations, mcpTasks, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("mcp_tasks_migration");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-mcptasks", display_name: "McpTasks" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("0026_mcp_tasks migration", () => {
  test("the mcp_tasks table exists with the documented columns", async () => {
    const res = (await testDb.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_tasks'`,
    )) as unknown as { rows: Array<{ column_name: string }> };
    const cols = new Set(res.rows.map((r) => r.column_name));
    for (const c of [
      "id",
      "tenant_id",
      "conversation_id",
      "turn_seq",
      "kind",
      "job_id",
      "request_source",
      "actor_id",
      "user_message_id",
      "result",
      "failure_reason",
      "cancelled_at",
      // 0012_mcp_task_heartbeat — worker-stamped progress heartbeat.
      "phase",
      "last_action",
      "progress_step",
      "heartbeat_at",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  });

  test("0012_mcp_task_heartbeat added the four progress columns as nullable", async () => {
    const res = (await testDb.db.execute(
      sql`SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'mcp_tasks'
            AND column_name IN ('phase','last_action','progress_step','heartbeat_at')`,
    )) as unknown as { rows: Array<{ column_name: string; is_nullable: string }> };
    const byName = new Map(res.rows.map((r) => [r.column_name, r.is_nullable]));
    for (const c of ["phase", "last_action", "progress_step", "heartbeat_at"]) {
      expect(byName.get(c)).toBe("YES");
    }
  });

  test("the (tenant, conversation, turn_seq) and (tenant, created_at) indexes exist", async () => {
    const res = (await testDb.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'mcp_tasks'`,
    )) as unknown as { rows: Array<{ indexname: string }> };
    const idx = new Set(res.rows.map((r) => r.indexname));
    expect(idx.has("mcp_tasks_conv_turn_idx")).toBe(true);
    expect(idx.has("mcp_tasks_tenant_created_idx")).toBe(true);
  });

  test("conversation_id cascades — deleting the conversation removes the index row", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "active", draft: {} })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const [task] = await testDb.db
      .insert(mcpTasks)
      .values({
        tenant_id: tenantId,
        conversation_id: conv.id,
        turn_seq: 1,
        kind: "start",
        actor_id: null,
        request_source: "mcp",
      })
      .returning();
    if (!task) throw new Error("seed mcp_task failed");

    await testDb.db.delete(conversations).where(eq(conversations.id, conv.id));

    const after = await testDb.db.select().from(mcpTasks).where(eq(mcpTasks.id, task.id));
    expect(after).toHaveLength(0);
  });
});
