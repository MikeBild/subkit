import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const TAG = "0006_drop_hosted_budget_reservations";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("drop-hosted-budget-reservations-migration");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

function migration(): EmbeddedMigration {
  const found = EMBEDDED_MIGRATIONS.find((item) => item.tag === TAG);
  if (!found) throw new Error(`${TAG} missing from the embedded bundle`);
  return found;
}

async function restoreTable(): Promise<void> {
  const baseline = EMBEDDED_MIGRATIONS[0];
  if (!baseline) throw new Error("baseline missing from the embedded bundle");
  const statements = baseline.statements.filter((statement) =>
    statement.includes("subkit.hosted_budget_reservations"),
  );
  expect(statements.length).toBeGreaterThanOrEqual(4);
  for (const statement of statements) await ctx.db.execute(sql.raw(statement));
}

async function runDropMigration(): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    for (const statement of migration().statements) await tx.execute(sql.raw(statement));
  });
}

async function tableExists(): Promise<boolean> {
  const result = (await ctx.db.execute(
    sql`SELECT to_regclass('subkit.hosted_budget_reservations') IS NOT NULL AS present`,
  )) as unknown as { rows: Array<{ present: boolean }> };
  return result.rows[0]?.present ?? false;
}

async function guardSource(): Promise<string> {
  const result = (await ctx.db.execute(
    sql`SELECT prosrc FROM pg_proc WHERE oid = 'subkit.hosted_operational_guard()'::regprocedure`,
  )) as unknown as { rows: Array<{ prosrc: string }> };
  return result.rows[0]?.prosrc ?? "";
}

describe(TAG, () => {
  test("a fresh database has no reservation table and the guard no longer names it", async () => {
    expect(migration().idx).toBe(6);
    expect(await tableExists()).toBe(false);
    const source = await guardSource();
    expect(source).toContain("hosted_work_admissions");
    expect(source).not.toContain("hosted_budget_reservations");
  });

  test("an upgraded installation drops the table together with its reservations", async () => {
    await restoreTable();
    const { tenant } = await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example",
        subject: "budget-upgrade-hosted",
        email: "budget-upgrade-hosted@example.test",
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
      ctx.db,
    );
    await ctx.db.execute(
      sql`INSERT INTO subkit.hosted_budget_reservations
            (tenant_id, request_key, month_bucket, currency, model, reserved_microunits, state)
          VALUES (${tenant.id}, ${"a".repeat(64)}, '2000-01', 'USD', 'provider:model', 100, 'reserved')`,
    );

    await runDropMigration();

    expect(await tableExists()).toBe(false);
    await runDropMigration();
    expect(await tableExists()).toBe(false);
  });
});
