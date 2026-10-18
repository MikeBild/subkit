import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { assignOperatorTenant } from "../set-operator-tenant.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const SYSTEM_TENANT = "00000000-0000-0000-0000-000000000000";

function operatorMigration() {
  const migration = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some((statement) => statement.includes('"tenants_operator_key"')),
  );
  if (!migration) throw new Error("operator tenant migration is not embedded");
  const backfill = migration.statements.find((statement) =>
    statement.trimStart().startsWith('UPDATE "tenants"'),
  );
  if (!backfill) throw new Error("operator tenant backfill statement is missing");
  return { migration, backfill };
}

const nextId = createDeterministicUuidFactory(1_140);

async function insertTenant(
  ctx: TestDb,
  slug: string,
  createdAt: string,
  opts: { id?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = opts.id ?? nextId();
  await ctx.pool.query(
    `INSERT INTO subkit.tenants (id, slug, display_name, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $2, $3, $3, $4)`,
    [id, slug, createdAt, opts.deleted ? createdAt : null],
  );
  return id;
}

async function insertSetupCompleted(ctx: TestDb, tenantId: string, ts: string): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO subkit.audit_log (id, ts, tenant_id, actor_type, action, resource_type, resource_id, result)
     VALUES ($1, $2, $3, 'system', 'setup.completed', 'bootstrap', $4, 'success')`,
    [nextId(), ts, SYSTEM_TENANT, tenantId],
  );
}

async function operators(ctx: TestDb): Promise<string[]> {
  const result = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM subkit.tenants WHERE is_operator ORDER BY id",
  );
  return result.rows.map((row) => row.id);
}

async function runBackfill(ctx: TestDb, sql: string): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("SET search_path TO subkit, pg_catalog, public");
    await client.query(sql);
  } finally {
    client.release();
  }
}

async function resetTenants(ctx: TestDb): Promise<void> {
  await ctx.pool.query("DELETE FROM subkit.tenants WHERE id <> $1", [SYSTEM_TENANT]);
}

test("migration adds the operator flag and backfills the oldest tenant on an upgraded install", async () => {
  const { migration } = operatorMigration();
  const ctx = await createTestDb("operator_tenant_upgrade", { upToIdx: migration.idx - 1 });
  try {
    const older = nextId();
    const newer = nextId();
    await ctx.pool.query(
      `INSERT INTO subkit.tenants (id, slug, display_name, created_at, updated_at)
       VALUES ($1, 'acme', 'Acme', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
              ($2, 'beta', 'Beta', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
      [older, newer],
    );
    const report = await runMigrations(ctx.db);
    expect(report.applied).toBe(EMBEDDED_MIGRATIONS.length - migration.idx);
    expect(await operators(ctx)).toEqual([older]);
  } finally {
    await ctx.cleanup();
  }
});

describe("operator tenant backfill order", () => {
  let ctx: TestDb;
  const { backfill } = operatorMigration();

  beforeAll(async () => {
    ctx = await createTestDb("operator_tenant_backfill");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("no tenants leaves the flag unassigned", async () => {
    await resetTenants(ctx);
    await runBackfill(ctx, backfill);
    expect(await operators(ctx)).toEqual([]);
  });

  test("falls back to the oldest live tenant, never a deleted or the system tenant", async () => {
    await resetTenants(ctx);
    await insertTenant(ctx, "gone", "2025-01-01T00:00:00Z", { deleted: true });
    const oldest = await insertTenant(ctx, "first", "2026-01-01T00:00:00Z");
    await insertTenant(ctx, "second", "2026-03-01T00:00:00Z");
    await runBackfill(ctx, backfill);
    expect(await operators(ctx)).toEqual([oldest]);
  });

  test("prefers the dev tenant slug default over older tenants", async () => {
    await resetTenants(ctx);
    await insertTenant(ctx, "first", "2025-06-01T00:00:00Z");
    const dev = await insertTenant(ctx, "default", "2026-01-01T00:00:00Z");
    await runBackfill(ctx, backfill);
    expect(await operators(ctx)).toEqual([dev]);
  });

  test("an existing operator is kept and the backfill is idempotent", async () => {
    await resetTenants(ctx);
    const chosen = await insertTenant(ctx, "chosen", "2026-05-01T00:00:00Z");
    await insertTenant(ctx, "default", "2026-01-01T00:00:00Z");
    await ctx.pool.query("UPDATE subkit.tenants SET is_operator = true WHERE id = $1", [chosen]);
    await runBackfill(ctx, backfill);
    await runBackfill(ctx, backfill);
    expect(await operators(ctx)).toEqual([chosen]);
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

  test("setup evidence wins over the dev slug and the oldest tenant", async () => {
    await resetTenants(ctx);
    await insertTenant(ctx, "default", "2025-01-01T00:00:00Z");
    await insertTenant(ctx, "older", "2024-01-01T00:00:00Z");
    const bootstrapped = await insertTenant(ctx, "acme", "2026-01-01T00:00:00Z");
    await insertSetupCompleted(ctx, bootstrapped, "2026-01-01T00:00:01Z");
    await runBackfill(ctx, backfill);
    expect(await operators(ctx)).toEqual([bootstrapped]);
  });
});
