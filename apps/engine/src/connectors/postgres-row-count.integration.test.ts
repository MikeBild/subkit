import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { getBuiltinTemplate } from "./templates.ts";

const rowCountQuery = () => {
  const rowCountRecipe = getBuiltinTemplate("postgres")!.recipes.find(
    (recipe) => recipe.slug === "row-count",
  )!;
  const [countStep] = rowCountRecipe.workflow.steps as Array<{ sql: { query: string } }>;
  return countStep!.sql.query;
};

describe("postgres row-count recipe SQL (#569)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb("postgres_row_count");
    await testDb.pool.query("CREATE SCHEMA row_count_probe");
    await testDb.pool.query("CREATE TABLE row_count_probe.filled (id integer)");
    await testDb.pool.query("INSERT INTO row_count_probe.filled VALUES (1), (2), (3)");
    await testDb.pool.query('CREATE TABLE row_count_probe."Empty Table" (id integer)');
  }, TEST_DB_HOOK_TIMEOUT);

  afterAll(async () => {
    await testDb?.cleanup();
  }, TEST_DB_HOOK_TIMEOUT);

  test("counts the rows of a filled table", async () => {
    const result = await testDb.pool.query(rowCountQuery(), ["row_count_probe", "filled"]);
    expect(Number(result.rows[0].n)).toBe(3);
  });

  test("counts zero rows of an empty table with a quoted name", async () => {
    const result = await testDb.pool.query(rowCountQuery(), ["row_count_probe", "Empty Table"]);
    expect(Number(result.rows[0].n)).toBe(0);
  });

  test("treats an injection attempt as a missing relation", async () => {
    await expect(
      testDb.pool.query(rowCountQuery(), [
        "row_count_probe",
        'filled"; drop table row_count_probe.filled; --',
      ]),
    ).rejects.toThrow(/does not exist/);
    const remaining = await testDb.pool.query(rowCountQuery(), ["row_count_probe", "filled"]);
    expect(Number(remaining.rows[0].n)).toBe(3);
  });
});
