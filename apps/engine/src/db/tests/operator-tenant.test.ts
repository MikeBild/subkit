import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { assignOperatorTenant } from "../set-operator-tenant.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const SYSTEM_TENANT = "00000000-0000-0000-0000-000000000000";

const nextId = createDeterministicUuidFactory(1_140);

async function insertTenant(ctx: TestDb, slug: string, createdAt: string): Promise<string> {
  const id = nextId();
  await ctx.pool.query(
    `INSERT INTO subkit.tenants (id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $2, $3, $3)`,
    [id, slug, createdAt],
  );
  return id;
}

async function operators(ctx: TestDb): Promise<string[]> {
  const result = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM subkit.tenants WHERE is_operator ORDER BY id",
  );
  return result.rows.map((row) => row.id);
}

async function resetTenants(ctx: TestDb): Promise<void> {
  await ctx.pool.query("DELETE FROM subkit.tenants WHERE id <> $1", [SYSTEM_TENANT]);
}

describe("operator tenant", () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await createTestDb("operator_tenant");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("the partial unique index rejects a second operator tenant", async () => {
    await resetTenants(ctx);
    const first = await insertTenant(ctx, "first", "2026-01-01T00:00:00Z");
    const second = await insertTenant(ctx, "second", "2026-02-01T00:00:00Z");
    await ctx.pool.query("UPDATE subkit.tenants SET is_operator = true WHERE id = $1", [first]);
    await expect(
      ctx.pool.query("UPDATE subkit.tenants SET is_operator = true WHERE id = $1", [second]),
    ).rejects.toThrow(/tenants_operator_key/);
  });

  test("--set-operator-tenant moves the flag atomically and audits it", async () => {
    await resetTenants(ctx);
    const first = await insertTenant(ctx, "first", "2026-01-01T00:00:00Z");
    const second = await insertTenant(ctx, "second", "2026-02-01T00:00:00Z");
    await ctx.pool.query("UPDATE subkit.tenants SET is_operator = true WHERE id = $1", [first]);
    const assigned = await assignOperatorTenant(ctx.db, "second");
    expect(assigned).toEqual({
      tenant_id: second,
      tenant_slug: "second",
      previous_tenant_id: first,
    });
    expect(await operators(ctx)).toEqual([second]);
    const audit = await ctx.pool.query<{ resource_id: string; tenant_id: string }>(
      "SELECT resource_id, tenant_id FROM subkit.audit_log WHERE action = 'tenant.operator_assigned'",
    );
    expect(audit.rows).toEqual([{ resource_id: second, tenant_id: SYSTEM_TENANT }]);
    await expect(assignOperatorTenant(ctx.db, "missing")).rejects.toThrow(/not found/);
    expect(await operators(ctx)).toEqual([second]);
  });
});
