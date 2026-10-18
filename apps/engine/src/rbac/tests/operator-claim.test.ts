import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { claimOperatorTenantIfUnassigned } from "../operator.ts";

const nextId = createDeterministicUuidFactory(1_150);

describe("operator tenant claim", () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await createTestDb("operator_claim");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function insertTenant(slug: string, deleted = false): Promise<string> {
    const id = nextId();
    await ctx.pool.query(
      `INSERT INTO subkit.tenants (id, slug, display_name, deleted_at)
       VALUES ($1, $2, $2, CASE WHEN $3::boolean THEN now() END)`,
      [id, slug, deleted],
    );
    return id;
  }

  async function operators(): Promise<string[]> {
    const result = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM subkit.tenants WHERE is_operator ORDER BY id",
    );
    return result.rows.map((row) => row.id);
  }

  async function reset(): Promise<void> {
    await ctx.pool.query(
      "DELETE FROM subkit.tenants WHERE id <> '00000000-0000-0000-0000-000000000000'",
    );
  }

  test("concurrent claims leave exactly one operator and none fails", async () => {
    await reset();
    const ids = await Promise.all([insertTenant("claim-a"), insertTenant("claim-b")]);
    const outcomes = await Promise.all(
      ids.map((id) => ctx.db.transaction((tx) => claimOperatorTenantIfUnassigned(tx, id))),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await operators()).toHaveLength(1);
  });

  test("a deleted operator tenant releases the slot for the next claim", async () => {
    await reset();
    const operator = await insertTenant("claim-old");
    await ctx.pool.query(
      "UPDATE subkit.tenants SET is_operator = true, deleted_at = now() WHERE id = $1",
      [operator],
    );
    const successor = await insertTenant("claim-new");
    const claimed = await ctx.db.transaction((tx) =>
      claimOperatorTenantIfUnassigned(tx, successor),
    );
    expect(claimed).toBe(true);
    expect(await operators()).toEqual([successor]);
  });

  test("a live operator is never replaced", async () => {
    await reset();
    const operator = await insertTenant("claim-live");
    await ctx.db.transaction((tx) => claimOperatorTenantIfUnassigned(tx, operator));
    const other = await insertTenant("claim-other");
    const claimed = await ctx.db.transaction((tx) => claimOperatorTenantIfUnassigned(tx, other));
    expect(claimed).toBe(false);
    expect(await operators()).toEqual([operator]);
  });
});
