import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { seedTenant } from "../../test-helpers/seed.ts";
import { TENANT_ROLE } from "../core/tenant-scope.ts";
import * as schema from "../schema/index.ts";
import { vaultItems } from "../schema/index.ts";
import { ensureTenantRowSecurity, readTenantRoleFacts } from "../tenant-role-preflight.ts";
import { withSystemScope, withTenantScope } from "../tenant-scope.ts";
import { failureCode, sealedItem } from "./row-security-setup.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "./setup.ts";

let ctx: TestDb;
let single: pg.Pool;
let su: NodePgDatabase<typeof schema>;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  ctx = await createTestDb("tenant_row_security_su");
  single = new pg.Pool({ connectionString: ctx.url, max: 1 });
  single.on("error", () => {});
  su = drizzle(single, { schema });
  tenantA = (await seedTenant(su, { slug: "row-security-su-a" })).id;
  tenantB = (await seedTenant(su, { slug: "row-security-su-b" })).id;
  await su
    .insert(vaultItems)
    .values([sealedItem(tenantA, "a-token"), sealedItem(tenantB, "b-token")]);
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await single?.end().catch(() => {});
  await ctx?.cleanup();
}, 30_000);

describe("row security for a superuser login", () => {
  test("the engine provisions the tenant role for a superuser and then reports ready", async () => {
    expect((await readTenantRoleFacts(single)).is_superuser).toBe(true);
    expect(await ensureTenantRowSecurity(single)).toMatchObject({ verdict: "ready" });
    expect(await readTenantRoleFacts(single)).toMatchObject({
      role_exists: true,
      can_assume_role: true,
      grants_present: true,
      role_bypasses_row_security: false,
    });
  });

  test("a tenant scope switches to the tenant role and sees only its tenant", async () => {
    const seen = await withTenantScope(su, tenantA, async (tx) => {
      const who = await tx.execute<{ acting: string }>(sql`SELECT current_user AS acting`);
      // tenant-filter:exempt — proves the policy filters when the query forgets the tenant
      const names = await tx.select({ name: vaultItems.name }).from(vaultItems);
      return { acting: who.rows[0]?.acting, names: names.map((row) => row.name) };
    });
    expect(seen).toEqual({ acting: TENANT_ROLE, names: ["a-token"] });
    expect(
      await failureCode(() =>
        withTenantScope(su, tenantA, (tx) =>
          tx.insert(vaultItems).values(sealedItem(tenantB, "smuggled")),
        ),
      ),
    ).toBe("42501");
  });

  test("the system scope keeps the superuser and sees every tenant", async () => {
    const seen = await withSystemScope(su, "test sweep", async (tx) => {
      const who = await tx.execute<{ acting: string }>(sql`SELECT current_user AS acting`);
      // tenant-filter:exempt — proves the system scope spans tenants
      const rows = await tx.select({ id: vaultItems.id }).from(vaultItems);
      return { acting: who.rows[0]?.acting, count: rows.length };
    });
    expect(seen.acting).not.toBe(TENANT_ROLE);
    expect(seen.count).toBe(2);
  });

  test("role and settings are gone after commit on a single-connection pool", async () => {
    await withTenantScope(su, tenantA, async () => undefined);
    const state = await single.query<{
      role: string;
      tenant: string | null;
      scope: string | null;
    }>(
      `SELECT current_setting('role') AS role, current_setting('subkit.tenant_id', true) AS tenant,
              current_setting('subkit.rls_scope', true) AS scope`,
    );
    expect(state.rows[0]?.role).toBe("none");
    expect(state.rows[0]?.tenant ?? "").toBe("");
    expect(state.rows[0]?.scope ?? "").toBe("");
  });
});
