// Boot-time seed orchestrator.
//
// Tests the new `seedAtBoot(db)` path that the engine binary calls
// after `runMigrations(db)`. This is the in-process replacement for
// the former `bun run db:seed` script.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, isNull, like } from "drizzle-orm";
import { permissions, roles, tenants, users } from "../schema/index.ts";
import { seedAtBoot } from "../seed.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;
const originalNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
  // We migrate but skip createTestDb's RBAC seed so we can observe the
  // first-run behaviour of seedAtBoot.
  ctx = await createTestDb("seed_at_boot");
  // Wipe RBAC + tenant rows that createTestDb may have planted so we
  // observe a fresh boot.
  await ctx.db.delete(users);
  await ctx.db.delete(tenants);
}, 60_000);

function restoreNodeEnv(): void {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
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
    process.env.NODE_ENV = "development";
    const r1 = await seedAtBoot(ctx.db);
    expect(r1.status).toBe("seeded");
    expect(r1.issued_keys.length).toBeGreaterThanOrEqual(1);

    const tenantsAfter = await ctx.db.select().from(tenants).where(eq(tenants.slug, "default"));
    expect(tenantsAfter.length).toBe(1);

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
    // Defence-in-depth against the orphan-RBAC failure mode that
    // 0014_drop_tunnels.sql exists to prevent: a fresh DB must not
    // surface tunnel:* permissions or the tunnel_agent built-in role,
    // regardless of how the seeder evolves. Pairs with the negative
    // assertion in the cli-rbac journey for the upgraded-DB path.
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
    // Wipe what the dev test left behind so we re-observe a fresh boot.
    await ctx.db.delete(users);
    await ctx.db.delete(tenants);

    process.env.NODE_ENV = "production";
    const r = await seedAtBoot(ctx.db);
    expect(r.status).toBe("already_seeded");
    expect(r.issued_keys).toEqual([]);

    const t = await ctx.db.select().from(tenants);
    expect(t.length).toBe(0);
  });
});
