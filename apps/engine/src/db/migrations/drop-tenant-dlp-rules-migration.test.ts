import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { hostedTenantUsage } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const TAG = "0002_drop_tenant_dlp_rules";
const RESOURCE = "tenant_dlp_rules";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("drop-tenant-dlp-rules-migration");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

function migration(tag: string): EmbeddedMigration {
  const found = EMBEDDED_MIGRATIONS.find((item) => item.tag === tag);
  if (!found) throw new Error(`${tag} missing from the embedded bundle`);
  return found;
}

function baselineStatements(): string[] {
  const baseline = EMBEDDED_MIGRATIONS[0];
  if (!baseline) throw new Error("baseline missing from the embedded bundle");
  return baseline.statements.filter(
    (statement) =>
      statement.includes("subkit.tenant_dlp_rules") ||
      statement.includes("subkit.hosted_meter_tenant_dlp_rules()"),
  );
}

async function restoreTable(): Promise<void> {
  const statements = baselineStatements();
  expect(statements.length).toBeGreaterThanOrEqual(4);
  for (const statement of statements) await ctx.db.execute(sql.raw(statement));
}

async function runDropMigration(): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    for (const statement of migration(TAG).statements) await tx.execute(sql.raw(statement));
  });
}

async function selfServiceTenant(subject: string): Promise<string> {
  const { tenant } = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  return tenant.id;
}

async function insertRules(tenantId: string): Promise<void> {
  await ctx.db.execute(
    sql`INSERT INTO subkit.tenant_dlp_rules (tenant_id, path_match, pattern_regex, action, reason)
        VALUES (${tenantId}, '**.email', '^.+@.+$', 'mask', 'email_pii'),
               (${tenantId}, '**.secret', NULL, 'drop', NULL)`,
  );
}

async function usage(tenantId: string) {
  const [row] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!row) throw new Error("hosted usage row missing");
  const counts = row.resource_counts as Record<string, string>;
  return { bytes: row.logical_bytes, count: counts[RESOURCE] ?? null };
}

async function exists(kind: "table" | "function"): Promise<boolean> {
  const result = (await ctx.db.execute(
    kind === "table"
      ? sql`SELECT to_regclass('subkit.tenant_dlp_rules') IS NOT NULL AS present`
      : sql`SELECT to_regprocedure('subkit.hosted_meter_tenant_dlp_rules()') IS NOT NULL AS present`,
  )) as unknown as { rows: Array<{ present: boolean }> };
  return result.rows[0]?.present ?? false;
}

describe(TAG, () => {
  test("a fresh database has neither the table nor its meter function", async () => {
    expect(migration(TAG).idx).toBe(2);
    expect(await exists("table")).toBe(false);
    expect(await exists("function")).toBe(false);
  });

  test("an upgraded installation releases the metered rule usage and drops the table", async () => {
    await restoreTable();
    const hosted = await selfServiceTenant("dlp-upgrade-hosted");
    const before = await usage(hosted);
    await insertRules(hosted);
    const metered = await usage(hosted);
    expect(metered.count).toBe("2");
    expect(metered.bytes).toBeGreaterThan(before.bytes);
    const operator = await seedTenant(ctx.db, { slug: "dlp-upgrade-operator" });
    await insertRules(operator.id);

    await runDropMigration();

    expect(await exists("table")).toBe(false);
    expect(await exists("function")).toBe(false);
    expect(await usage(hosted)).toEqual({ bytes: before.bytes, count: null });
  });

  test("rerunning the statements leaves usage unchanged", async () => {
    const tenants = (
      await ctx.db.select({ id: hostedTenantUsage.tenant_id }).from(hostedTenantUsage)
    ).map((row) => row.id);
    const before = await Promise.all(tenants.map(usage));
    await runDropMigration();
    expect(await Promise.all(tenants.map(usage))).toEqual(before);
  });
});
