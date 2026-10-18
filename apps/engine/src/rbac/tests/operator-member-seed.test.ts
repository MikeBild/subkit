import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { permissions, rolePermissions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { OPERATOR_PERMISSIONS } from "../catalog.ts";
import { seedBuiltinRolesAndPermissions } from "../seed.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("operator_member_seed");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function grantedOperatorPermissions(roleId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ name: permissions.name })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permission_id))
    .where(
      and(
        eq(rolePermissions.role_id, roleId),
        inArray(permissions.name, [...OPERATOR_PERMISSIONS]),
      ),
    );
  return rows.map((row) => row.name).sort();
}

test("the member role never keeps an operator permission, even one granted before the upgrade", async () => {
  const ids = await seedBuiltinRolesAndPermissions(ctx.db);
  const [metrics] = await ctx.db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.name, "metrics:read"));
  if (!metrics) throw new Error("metrics:read permission missing");
  await ctx.db
    .insert(rolePermissions)
    .values({ role_id: ids.member, permission_id: metrics.id })
    .onConflictDoNothing();
  expect(await grantedOperatorPermissions(ids.member)).toEqual(["metrics:read"]);

  await seedBuiltinRolesAndPermissions(ctx.db);

  expect(await grantedOperatorPermissions(ids.member)).toEqual([]);
  expect(await grantedOperatorPermissions(ids.admin)).toEqual([...OPERATOR_PERMISSIONS].sort());
  expect(await grantedOperatorPermissions(ids.metrics_scraper)).toEqual(["metrics:read"]);
});
