import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generateKey } from "../../identity/api-key.ts";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import { apiKeys, dataMigrations, systemAccounts, tenants, users } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { METRICS_SCOPE_BACKFILL_NAME, runMetricsScopeBackfill } from "./metrics-scope-backfill.ts";

let ctx: TestDb;
let tenantId: string;
let adminUserId: string;
let memberUserId: string;
let adminAccountId: string;

beforeAll(async () => {
  ctx = await createTestDb("metrics_scope_backfill");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-metrics-scope", display_name: "MetricsScopeBackfill" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;

  const roleIds = await seedBuiltinRolesAndPermissions(ctx.db);
  const [admin] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "admin@metrics-scope.test",
      role_id: roleIds.admin,
    })
    .returning();
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "member@metrics-scope.test",
      role_id: roleIds.member,
    })
    .returning();
  const [account] = await ctx.db
    .insert(systemAccounts)
    .values({
      tenant_id: tenantId,
      name: "admin-bot",
      description: "system account carrying the admin role",
      role_id: roleIds.admin,
    })
    .returning();
  if (!admin || !member || !account) throw new Error("seed identities failed");
  adminUserId = admin.id;
  memberUserId = member.id;
  adminAccountId = account.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function clearMarker(): Promise<void> {
  await ctx.db.delete(dataMigrations).where(eq(dataMigrations.name, METRICS_SCOPE_BACKFILL_NAME));
}

async function seedKey(
  owner: { user_id: string } | { system_account_id: string },
  scopes: string[],
): Promise<string> {
  const key = generateKey();
  const [row] = await ctx.db
    .insert(apiKeys)
    .values({
      tenant_id: tenantId,
      ...owner,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes,
    })
    .returning();
  if (!row) throw new Error("seed key failed");
  return row.id;
}

async function scopesOf(id: string): Promise<unknown> {
  const [row] = await ctx.db
    .select({ scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  return row?.scopes;
}

describe("metrics:read backfill", () => {
  test("grants the scope to a narrow admin-owned key — the row whose answer would change", async () => {
    await clearMarker();
    const userKey = await seedKey({ user_id: adminUserId }, ["connector:read"]);
    const accountKey = await seedKey({ system_account_id: adminAccountId }, ["connector:read"]);

    const report = await runMetricsScopeBackfill(ctx.db);
    expect(report.skipped).toBe(false);
    expect(report.granted).toBeGreaterThanOrEqual(2);

    expect(await scopesOf(userKey)).toEqual(["connector:read", "metrics:read"]);
    expect(await scopesOf(accountKey)).toEqual(["connector:read", "metrics:read"]);
  });

  test("leaves alone every key whose answer is unchanged", async () => {
    await clearMarker();
    const memberKey = await seedKey({ user_id: memberUserId }, ["connector:read"]);
    const wildcardKey = await seedKey({ user_id: adminUserId }, ["*"]);
    const scraperKey = await seedKey({ system_account_id: adminAccountId }, ["metrics:read"]);

    await runMetricsScopeBackfill(ctx.db);

    expect(await scopesOf(memberKey)).toEqual(["connector:read"]);
    expect(await scopesOf(wildcardKey)).toEqual(["*"]);
    expect(await scopesOf(scraperKey)).toEqual(["metrics:read"]);
  });

  test("is a marker no-op on the second run", async () => {
    await clearMarker();
    await runMetricsScopeBackfill(ctx.db);
    const again = await runMetricsScopeBackfill(ctx.db);
    expect(again).toEqual({ skipped: true, granted: 0 });
  });
});
