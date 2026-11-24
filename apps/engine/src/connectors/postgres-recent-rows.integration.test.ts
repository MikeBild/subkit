import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { getBuiltinTemplate } from "./templates.ts";

const recentRowsQuery = () => {
  const recentRowsRecipe = getBuiltinTemplate("postgres")!.recipes.find(
    (recipe) => recipe.slug === "recent-rows",
  )!;
  const [rowsStep] = recentRowsRecipe.workflow.steps as Array<{ sql: { query: string } }>;
  return rowsStep!.sql.query;
};

const rowIds = (rows: Array<{ row: { id: number } }>) => rows.map((record) => record.row.id);

describe("postgres recent-rows recipe SQL (#571)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb("postgres_recent_rows");
    await testDb.pool.query("CREATE SCHEMA recent_rows_probe");
    await testDb.pool.query(
      "CREATE TABLE recent_rows_probe.events (id integer, note text, created_at timestamptz, seen_at timestamptz)",
    );
    await testDb.pool.query(
      `INSERT INTO recent_rows_probe.events VALUES
        (1, 'first', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'),
        (2, 'a & b <c> "q"', '2026-01-02T00:00:00Z', '2026-01-04T00:00:00Z'),
        (3, 'third', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
        (4, 'fourth', '2026-01-04T00:00:00Z', '2026-01-02T00:00:00Z'),
        (5, 'fifth', '2026-01-05T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    await testDb.pool.query(
      'CREATE TABLE recent_rows_probe."Mixed Case" (id integer, created_at timestamptz)',
    );
    await testDb.pool.query(
      `INSERT INTO recent_rows_probe."Mixed Case" VALUES (10, '2026-02-01T00:00:00Z'), (11, '2026-02-02T00:00:00Z')`,
    );
  }, TEST_DB_HOOK_TIMEOUT);

  afterAll(async () => {
    await testDb?.cleanup();
  }, TEST_DB_HOOK_TIMEOUT);

  test("returns the newest rows by created_at in descending order", async () => {
    const result = await testDb.pool.query(recentRowsQuery(), [
      "recent_rows_probe",
      "events",
      "created_at",
      3,
    ]);
    expect(rowIds(result.rows)).toEqual([5, 4, 3]);
  });

  test("orders by a custom timestamp column and keeps special characters intact", async () => {
    const result = await testDb.pool.query(recentRowsQuery(), [
      "recent_rows_probe",
      "events",
      "seen_at",
      2,
    ]);
    expect(rowIds(result.rows)).toEqual([1, 2]);
    expect(result.rows[1].row.note).toBe('a & b <c> "q"');
  });

  test("reads a quoted mixed-case table name", async () => {
    const result = await testDb.pool.query(recentRowsQuery(), [
      "recent_rows_probe",
      "Mixed Case",
      "created_at",
      3,
    ]);
    expect(rowIds(result.rows)).toEqual([11, 10]);
  });

  test("treats an injection attempt as a missing relation", async () => {
    await expect(
      testDb.pool.query(recentRowsQuery(), [
        "recent_rows_probe",
        'events"; drop table recent_rows_probe.events; --',
        "created_at",
        3,
      ]),
    ).rejects.toThrow(/does not exist/);
    const remaining = await testDb.pool.query(recentRowsQuery(), [
      "recent_rows_probe",
      "events",
      "created_at",
      10,
    ]);
    expect(remaining.rows).toHaveLength(5);
  });
});
