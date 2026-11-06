import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { HOSTED_METER_EXEMPTIONS } from "../hosted-meter-exemptions.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const AFTER_ROW_INSERT_UPDATE_DELETE = 29;

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("hosted-meter-coverage");
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

async function tenantTables(): Promise<string[]> {
  const result = (await ctx.db.execute(
    sql`SELECT c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'subkit' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`,
  )) as unknown as { rows: Array<{ name: string }> };
  return result.rows.map((row) => row.name);
}

async function meteredTables(): Promise<Map<string, { tgtype: number; fn: string }>> {
  const result = (await ctx.db.execute(
    sql`SELECT c.relname AS name, t.tgtype::int AS tgtype, p.proname AS fn FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'subkit' AND NOT t.tgisinternal AND t.tgname = 'hosted_meter_' || c.relname`,
  )) as unknown as { rows: Array<{ name: string; tgtype: number; fn: string }> };
  return new Map(result.rows.map((row) => [row.name, { tgtype: row.tgtype, fn: row.fn }]));
}

describe("hosted meter coverage", () => {
  test("every tenant table is metered or exempt with a reason", async () => {
    const metered = await meteredTables();
    const uncovered = (await tenantTables()).filter(
      (table) => !metered.has(table) && !Object.hasOwn(HOSTED_METER_EXEMPTIONS, table),
    );
    expect(uncovered).toEqual([]);
  });

  test("every meter trigger fires after each row insert, update and delete through its own function", async () => {
    const miswired = [...(await meteredTables())]
      .filter(
        ([table, trigger]) =>
          trigger.tgtype !== AFTER_ROW_INSERT_UPDATE_DELETE ||
          trigger.fn !== `hosted_meter_${table}`,
      )
      .map(([table]) => table);
    expect(miswired).toEqual([]);
  });

  test("every exemption names an existing unmetered tenant table and gives a reason", async () => {
    const tables = new Set(await tenantTables());
    const metered = await meteredTables();
    const stale = Object.entries(HOSTED_METER_EXEMPTIONS)
      .filter(([table, reason]) => !tables.has(table) || metered.has(table) || reason.trim() === "")
      .map(([table]) => table);
    expect(stale).toEqual([]);
  });
});
