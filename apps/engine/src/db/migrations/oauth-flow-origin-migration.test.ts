import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { connectors, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

let testDb: TestDb;
let tenantId: string;

const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0075_oauth_flow_origin");

async function runBackfill(): Promise<void> {
  if (!migration) throw new Error("migration 0075_oauth_flow_origin is not embedded");
  const statement = migration.statements.find((s) => s.includes('UPDATE "connectors"'));
  if (!statement) throw new Error("0075_oauth_flow_origin has no breaker backfill");
  await testDb.db.execute(sql.raw(statement));
}

async function seed(slug: string, circuit_state: string): Promise<string> {
  const [row] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug,
      display_name: slug,
      driver: "http",
      environment: "prod",
      auth_type: "none",
      base_url: "https://api.example.org",
      config: {},
      circuit_state,
      circuit_opened_at: sql`now() - interval '90 days'`,
    })
    .returning({ id: connectors.id });
  if (!row) throw new Error("seed connector failed");
  return row.id;
}

async function openedAt(id: string): Promise<Date | null | undefined> {
  const [row] = await testDb.db
    .select({ circuit_opened_at: connectors.circuit_opened_at })
    .from(connectors)
    .where(eq(connectors.id, id));
  return row?.circuit_opened_at;
}

beforeAll(async () => {
  testDb = await createTestDb("oauth_flow_origin");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-oauth-flow-origin", display_name: "OAuth flow origin" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("0075_oauth_flow_origin", () => {
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

  test("a closed breaker loses its stamp; an open or half-open one keeps it", async () => {
    const closed = await seed("closed-with-stamp", "closed");
    const open = await seed("still-open", "open");
    const halfOpen = await seed("being-probed", "half-open");

    await runBackfill();

    expect(await openedAt(closed)).toBeNull();
    expect(await openedAt(open)).toBeInstanceOf(Date);
    expect(await openedAt(halfOpen)).toBeInstanceOf(Date);
  });
});
