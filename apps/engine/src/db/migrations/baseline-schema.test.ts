import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { seedTenant } from "../../test-helpers/seed.ts";
import { roles } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("baseline-schema");
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

async function present(expression: string): Promise<boolean> {
  const result = await ctx.pool.query(`SELECT (${expression}) IS NOT NULL AS present`);
  return result.rows[0]?.present ?? false;
}

describe("baseline schema", () => {
  test("workflow review receipts carry their hosted meter trigger", async () => {
    const result = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgrelid = 'subkit.workflow_review_receipts'::regclass
          AND tgname = 'hosted_meter_workflow_review_receipts' AND NOT tgisinternal`,
    );
    expect(result.rows).toEqual([{ n: 1 }]);
  });

  test("tenant DLP rules and hosted budget reservations are gone", async () => {
    expect(await present("to_regclass('subkit.tenant_dlp_rules')")).toBe(false);
    expect(await present("to_regprocedure('subkit.hosted_meter_tenant_dlp_rules()')")).toBe(false);
    expect(await present("to_regclass('subkit.hosted_budget_reservations')")).toBe(false);
    const guard = await ctx.pool.query(
      "SELECT prosrc FROM pg_proc WHERE oid = 'subkit.hosted_operational_guard()'::regprocedure",
    );
    expect(guard.rows[0]?.prosrc).toContain("hosted_work_admissions");
    expect(guard.rows[0]?.prosrc).not.toContain("hosted_budget_reservations");
  });

  test("a custom role with a built-in name is refused", async () => {
    const tenant = await seedTenant(ctx.db, { slug: "reserved-roles", display_name: "Reserved" });
    const refusal = await ctx.db
      .insert(roles)
      .values({ tenant_id: tenant.id, name: "admin", is_builtin: false })
      .then(
        () => undefined,
        (err: { cause?: { constraint?: string } }) => err.cause?.constraint,
      );
    expect(refusal).toBe("roles_reserved_name_builtin_only");
  });

  test("a new workspace starts with a chosen spend limit of 50 $ and no token cap column", async () => {
    await ctx.db.execute(
      sql`INSERT INTO tenants (slug, display_name) VALUES ('spend-limit', 'Spend')`,
    );
    const { rows } = await ctx.db.execute<{ limit: string; chosen: Date | null }>(sql`
      SELECT spend_limit_usd AS limit, spend_limit_chosen_at AS chosen FROM tenants WHERE slug = 'spend-limit'
    `);
    expect(Number(rows[0]?.limit)).toBe(50);
    expect(rows[0]?.chosen).not.toBeNull();
    const columns = await ctx.pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_llm_settings' AND column_name = 'llm_monthly_token_budget'`,
    );
    expect(columns.rows).toEqual([]);
  });
});
