import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb("oauth_flow_origin");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-oauth-flow-origin", display_name: "OAuth flow origin" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("oauth flow origin", () => {
  test("adds a nullable origin to both sign-in state tables", async () => {
    const rows = await testDb.db.execute<{ table_name: string; is_nullable: string }>(sql`
      SELECT table_name, is_nullable FROM information_schema.columns
       WHERE column_name = 'origin'
         AND table_name IN ('connector_oauth_states', 'mcp_oauth_states')
         AND table_schema = current_schema()
       ORDER BY table_name
    `);
    expect(rows.rows).toEqual([
      { table_name: "connector_oauth_states", is_nullable: "YES" },
      { table_name: "mcp_oauth_states", is_nullable: "YES" },
    ]);
  });
});
