import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { seedTenant } from "../../test-helpers/seed.ts";
import { ROW_SCOPE_POLICY, ROW_SCOPED_TABLES } from "../core/tenant-scope.ts";
import { vaultItems } from "../schema/index.ts";
import {
  ensureTenantRowSecurity,
  readTenantRoleFacts,
  tenantRolePreflight,
} from "../tenant-role-preflight.ts";
import { withSystemScope, withTenantScope } from "../tenant-scope.ts";
import {
  createRowSecurityDb,
  failureCode,
  type RowSecurityDb,
  sealedItem,
} from "./row-security-setup.ts";
import { TEST_DB_HOOK_TIMEOUT } from "./setup.ts";

let rls: RowSecurityDb;
let tenantA: string;
let tenantB: string;

const owner = () => rls.owner.db;
const ownerPool = () => rls.owner.pool;

async function sessionState() {
  const result = await ownerPool().query<{
    acting: string;
    role: string;
    tenant: string | null;
    scope: string | null;
  }>(
    `SELECT current_user AS acting, current_setting('role') AS role,
            current_setting('subkit.tenant_id', true) AS tenant,
            current_setting('subkit.rls_scope', true) AS scope`,
  );
  return result.rows[0];
}

async function visibleNames(): Promise<string[]> {
  const rows = await ownerPool().query<{ name: string }>(
    "SELECT name FROM subkit.vault_items ORDER BY name",
  );
  return rows.rows.map((row) => row.name);
}

beforeAll(async () => {
  rls = await createRowSecurityDb("tenant_row_security");
  tenantA = (await seedTenant(owner(), { slug: "row-security-a" })).id;
  tenantB = (await seedTenant(owner(), { slug: "row-security-b" })).id;
  await withSystemScope(owner(), "seed fixture secrets", (tx) =>
    tx.insert(vaultItems).values([sealedItem(tenantA, "a-token"), sealedItem(tenantB, "b-token")]),
  );
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await rls?.cleanup();
}, 30_000);

describe("forced row security for a plain table owner", () => {
  test("the login is a plain owner and needs no role", async () => {
    const facts = await readTenantRoleFacts(ownerPool());
    expect(facts).toMatchObject({
      login_role: rls.owner.role,
      is_superuser: false,
      login_bypasses_row_security: false,
      row_security_forced: true,
    });
    expect(await tenantRolePreflight(ownerPool())).toMatchObject({ verdict: "ready" });
    expect(await ensureTenantRowSecurity(ownerPool())).toMatchObject({ verdict: "ready" });
  });

  test("every row-scoped table is forced and carries one policy for every role", async () => {
    const tables = await ownerPool().query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'subkit' AND c.relrowsecurity ORDER BY c.relname`,
    );
    const expected = [...ROW_SCOPED_TABLES].sort();
    expect(tables.rows.map((row) => row.relname)).toEqual(expected);
    expect(tables.rows.every((row) => row.forced)).toBe(true);
    const policies = await ownerPool().query<{
      tablename: string;
      policyname: string;
      roles: string;
    }>(
      `SELECT tablename, policyname, roles::text AS roles FROM pg_policies
        WHERE schemaname = 'subkit' ORDER BY tablename`,
    );
    expect(policies.rows).toEqual(
      expected.map((tablename) => ({ tablename, policyname: ROW_SCOPE_POLICY, roles: "{public}" })),
    );
  });

  test("without a scope the owner reads no rows and cannot write", async () => {
    expect(await visibleNames()).toEqual([]);
    expect(
      await failureCode(() => owner().insert(vaultItems).values(sealedItem(tenantA, "unscoped"))),
    ).toBe("42501");
    const swept = await ownerPool().query("UPDATE subkit.vault_items SET last_used_at = now()");
    expect(swept.rowCount).toBe(0);
  });

  test("a tenant scope sees only its tenant even when the query forgets the filter", async () => {
    const names = await withTenantScope(owner(), tenantA, async (tx) =>
      // tenant-filter:exempt — proves the policy filters when the query forgets the tenant
      (await tx.select({ name: vaultItems.name }).from(vaultItems)).map((row) => row.name),
    );
    expect(names).toEqual(["a-token"]);
  });

  test("a tenant scope cannot reach another tenant", async () => {
    expect(
      await failureCode(() =>
        withTenantScope(owner(), tenantA, (tx) =>
          tx.insert(vaultItems).values(sealedItem(tenantB, "smuggled")),
        ),
      ),
    ).toBe("42501");
    const touched = await withTenantScope(owner(), tenantA, (tx) =>
      tx
        .update(vaultItems)
        .set({ description: "overwritten" })
        .where(eq(vaultItems.tenant_id, tenantB))
        .returning({ id: vaultItems.id }),
    );
    expect(touched).toEqual([]);
    const removed = await withTenantScope(owner(), tenantA, (tx) =>
      tx
        .delete(vaultItems)
        .where(eq(vaultItems.tenant_id, tenantB))
        .returning({ id: vaultItems.id }),
    );
    expect(removed).toEqual([]);
    expect(
      await failureCode(() =>
        withTenantScope(owner(), tenantA, (tx) =>
          tx
            .update(vaultItems)
            .set({ tenant_id: tenantB })
            .where(eq(vaultItems.tenant_id, tenantA)),
        ),
      ),
    ).toBe("42501");
  });

  test("the system scope sees and changes every tenant", async () => {
    const tenants = await withSystemScope(owner(), "test sweep", async (tx) =>
      // tenant-filter:exempt — proves the system scope spans tenants
      (await tx.select({ tenant_id: vaultItems.tenant_id }).from(vaultItems)).map(
        (row) => row.tenant_id,
      ),
    );
    expect(new Set(tenants)).toEqual(new Set([tenantA, tenantB]));
    const swept = await withSystemScope(owner(), "test sweep", (tx) =>
      tx.execute(sql`UPDATE subkit.vault_items SET last_used_at = now()`),
    );
    expect(swept.rowCount).toBe(2);
  });

  test("scopes refuse a malformed tenant or an empty reason before touching the database", async () => {
    await expect(withTenantScope(owner(), "", async () => 1)).rejects.toThrow(TypeError);
    await expect(
      withTenantScope(owner(), `${tenantA}'; RESET ROLE; --`, async () => 1),
    ).rejects.toThrow(TypeError);
    await expect(withSystemScope(owner(), " ", async () => 1)).rejects.toThrow(TypeError);
  });

  test("the settings are gone after commit on a single-connection pool", async () => {
    expect(ownerPool().options.max).toBe(1);
    await withTenantScope(owner(), tenantA, async (tx) => {
      const inside = await tx.execute<{ acting: string; tenant: string; scope: string }>(
        sql`SELECT current_user AS acting, current_setting('subkit.tenant_id', true) AS tenant,
                   current_setting('subkit.rls_scope', true) AS scope`,
      );
      expect(inside.rows[0]).toEqual({ acting: rls.owner.role, tenant: tenantA, scope: "tenant" });
    });
    await withSystemScope(owner(), "test sweep", async () => undefined);
    const state = await sessionState();
    expect(state?.acting).toBe(rls.owner.role);
    expect(state?.role).toBe("none");
    expect(state?.tenant ?? "").toBe("");
    expect(state?.scope ?? "").toBe("");
    expect(await visibleNames()).toEqual([]);
  });

  test("the settings are gone after a rollback", async () => {
    await expect(
      withSystemScope(owner(), "test sweep", async () => {
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    const state = await sessionState();
    expect(state?.tenant ?? "").toBe("");
    expect(state?.scope ?? "").toBe("");
    expect(await visibleNames()).toEqual([]);
  });

  test("a scope inside an owner transaction leaves the transaction unscoped again", async () => {
    await owner().transaction(async (outer) => {
      const scoped = await withTenantScope(
        outer,
        tenantA,
        async (tx) =>
          // tenant-filter:exempt — counts what the policy lets through
          (await tx.select({ id: vaultItems.id }).from(vaultItems)).length,
      );
      expect(scoped).toBe(1);
      const after = await outer.execute<{ tenant: string | null; scope: string | null }>(
        sql`SELECT current_setting('subkit.tenant_id', true) AS tenant,
                   current_setting('subkit.rls_scope', true) AS scope`,
      );
      expect(after.rows[0]?.tenant ?? "").toBe("");
      expect(after.rows[0]?.scope ?? "").toBe("");
      const hidden = await outer.execute(sql`SELECT id FROM subkit.vault_items`);
      expect(hidden.rows).toEqual([]);
    });
  });

  test("a system scope inside a tenant scope returns to the tenant", async () => {
    await withTenantScope(owner(), tenantA, async (outer) => {
      const all = await withSystemScope(
        outer,
        "test sweep",
        async (tx) =>
          // tenant-filter:exempt — reads what the system scope lets through
          (await tx.select({ id: vaultItems.id }).from(vaultItems)).length,
      );
      expect(all).toBe(2);
      // tenant-filter:exempt — reads what the outer policy lets through
      const back = await outer.select({ name: vaultItems.name }).from(vaultItems);
      expect(back.map((row) => row.name)).toEqual(["a-token"]);
    });
  });

  test("a tenant scope inside another tenant scope returns to the outer tenant", async () => {
    await withTenantScope(owner(), tenantA, async (outer) => {
      const inner = await withTenantScope(outer, tenantB, async (tx) =>
        // tenant-filter:exempt — reads what the inner policy lets through
        (await tx.select({ name: vaultItems.name }).from(vaultItems)).map((row) => row.name),
      );
      expect(inner).toEqual(["b-token"]);
      // tenant-filter:exempt — reads what the outer policy lets through
      const back = await outer.select({ name: vaultItems.name }).from(vaultItems);
      expect(back.map((row) => row.name)).toEqual(["a-token"]);
    });
  });

  test("owner schema changes keep working under forced row security", async () => {
    await ownerPool().query("ALTER TABLE subkit.vault_items ADD COLUMN row_security_probe text");
    await ownerPool().query("ALTER TABLE subkit.vault_items DROP COLUMN row_security_probe");
  });
});
