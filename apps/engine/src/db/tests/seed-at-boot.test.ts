import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, isNull, like } from "drizzle-orm";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { permissions, roles, tenants, users } from "../schema/index.ts";
import { seedAtBoot } from "../seed.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;
const originalNodeEnv = testEnv.NODE_ENV;

beforeAll(async () => {
  ctx = await createTestDb("seed_at_boot");
  await ctx.db.delete(users);
  await ctx.db.delete(tenants);
}, 60_000);

function restoreNodeEnv(): void {
  if (originalNodeEnv === undefined) delete testEnv.NODE_ENV;
  else testEnv.NODE_ENV = originalNodeEnv;
}

afterAll(async () => {
  restoreNodeEnv();
  await ctx.cleanup();
}, 30_000);

afterEach(() => {
  restoreNodeEnv();
});

describe("seedAtBoot (development)", () => {
  test("first call inserts dev fixtures + RBAC; second call is a no-op", async () => {
    testEnv.NODE_ENV = "development";
    const r1 = await seedAtBoot(ctx.db);
    expect(r1.status).toBe("seeded");
    expect(r1.issued_keys.length).toBeGreaterThanOrEqual(1);

    const tenantsAfter = await ctx.db.select().from(tenants).where(eq(tenants.slug, "default"));
    expect(tenantsAfter.length).toBe(1);
    expect(tenantsAfter[0]?.is_operator).toBe(true);

    const r2 = await seedAtBoot(ctx.db);
    expect(r2.status).toBe("already_seeded");
    expect(r2.issued_keys).toEqual([]);
  });

  test("RBAC permissions catalog is non-empty after seedAtBoot", async () => {
    const perms = await ctx.db.select().from(permissions);
    expect(perms.length).toBeGreaterThan(0);
    const builtinRoles = await ctx.db.select().from(roles).where(isNull(roles.tenant_id));
    expect(builtinRoles.length).toBe(5);
  });

  test("no tunnel:* permissions and no tunnel_agent role survive on a fresh DB", async () => {
    const ghostPerms = await ctx.db
      .select()
      .from(permissions)
      .where(like(permissions.name, "tunnel:%"));
    expect(ghostPerms.length).toBe(0);
    const ghostRoles = await ctx.db.select().from(roles).where(eq(roles.name, "tunnel_agent"));
    expect(ghostRoles.length).toBe(0);
  });
});

describe("seedAtBoot (production)", () => {
  test("does NOT create the dev tenant — keeps tenants table empty for first-run /v1/setup", async () => {
    await ctx.db.delete(users);
    await ctx.db.delete(tenants);

    testEnv.NODE_ENV = "production";
    const r = await seedAtBoot(ctx.db);
    expect(r.status).toBe("already_seeded");
    expect(r.issued_keys).toEqual([]);

    const t = await ctx.db.select().from(tenants);
    expect(t.length).toBe(0);
  });
});
