import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { localDatabaseUrl } from "../../../../../scripts/lib/local-database-url.ts";
import { getCredentialForConnector, upsertCredential } from "../../credentials/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedConnector, seedTenant } from "../../test-helpers/seed.ts";
import { VAULT_PERMISSION, type VaultViewer } from "../../vault/core/vault-item.ts";
import {
  createVaultItem,
  listVaultItems,
  resolveVaultHandle,
  revealVaultItem,
} from "../../vault/service.ts";
import { TENANT_ROLE } from "../core/tenant-scope.ts";
import rowSecuritySql from "../migrations/0007_tenant_row_security.sql" with { type: "text" };
import * as schema from "../schema/index.ts";
import { vaultItems } from "../schema/index.ts";
import {
  ensureTenantRowSecurity,
  readTenantRoleFacts,
  tenantRolePreflight,
} from "../tenant-role-preflight.ts";
import { withTenantScope } from "../tenant-scope.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "./setup.ts";

const SCOPED_TABLES = [
  "auth_provider_configs",
  "chat_workspaces",
  "cockpit_push_keys",
  "cockpit_push_subscriptions",
  "subscriptions",
  "tool_approvals",
  "vault_items",
  "webhooks_inbound",
  "workflow_run_state",
];
const OWNER_PASSWORD = "synthetic-row-security-test-only";
const ADMIN_VIEWER: VaultViewer = {
  user_id: null,
  permissions: new Set(Object.values(VAULT_PERMISSION)),
};

let ctx: TestDb;
let ownerRole: string;
let ownerPool: pg.Pool;
let owner: NodePgDatabase<typeof schema>;
let tenantA: string;
let tenantB: string;

function pgCode(error: unknown): string | undefined {
  const direct = (error as { code?: string }).code;
  return direct ?? (error as { cause?: { code?: string } }).cause?.code;
}

async function failureCode(operation: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await operation();
    return "no_error";
  } catch (error) {
    return pgCode(error);
  }
}

function sealedItem(tenant_id: string, name: string) {
  return {
    tenant_id,
    kind: "secret" as const,
    name,
    environment: "dev" as const,
    mode: "bearer" as const,
    ciphertext: Buffer.from("fixture-ciphertext"),
    iv: Buffer.from("fixture-iv"),
    auth_tag: Buffer.from("fixture-tag"),
  };
}

async function sessionState() {
  const result = await ownerPool.query<{
    acting: string;
    role: string;
    tenant: string | null;
  }>(
    "SELECT current_user AS acting, current_setting('role') AS role, current_setting('subkit.tenant_id', true) AS tenant",
  );
  return result.rows[0];
}

async function handOverOwnership(role: string): Promise<void> {
  await ctx.pool.query(`
    DO $$
    DECLARE item record;
    BEGIN
      ALTER SCHEMA subkit OWNER TO "${role}";
      FOR item IN
        SELECT format('%I.%I', n.nspname, c.relname) AS name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'subkit' AND c.relkind IN ('r', 'p')
      LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO %I', item.name, '${role}');
      END LOOP;
      FOR item IN
        SELECT p.oid::regprocedure::text AS name
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'subkit'
      LOOP
        EXECUTE format('ALTER ROUTINE %s OWNER TO %I', item.name, '${role}');
      END LOOP;
    END $$`);
}

async function applyRowSecurity(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = subkit, pg_catalog, public");
    for (const statement of rowSecuritySql.split("--> statement-breakpoint")) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  ctx = await createTestDb("tenant_row_security");
  ownerRole = `rls_owner_${ctx.dbName.replace(/[^a-z0-9_]/g, "").slice(-28)}`;
  await ctx.pool.query(
    `CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${OWNER_PASSWORD}'`,
  );
  await ctx.pool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${TENANT_ROLE} NOLOGIN NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END $$`);
  await ctx.pool.query(`GRANT ${TENANT_ROLE} TO "${ownerRole}"`);
  await handOverOwnership(ownerRole);

  const url = new URL(ctx.url);
  url.username = ownerRole;
  url.password = OWNER_PASSWORD;
  ownerPool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  ownerPool.on("error", () => {});
  owner = drizzle(ownerPool, { schema });

  await applyRowSecurity(ownerPool);
  await applyRowSecurity(ownerPool);

  tenantA = (await seedTenant(owner, { slug: "row-security-a" })).id;
  tenantB = (await seedTenant(owner, { slug: "row-security-b" })).id;
  await owner
    .insert(vaultItems)
    .values([sealedItem(tenantA, "a-token"), sealedItem(tenantB, "b-token")]);
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await ownerPool?.end().catch(() => {});
  await ctx?.cleanup();
  if (!ownerRole) return;
  const admin = new pg.Client({ connectionString: localDatabaseUrl(testEnv) });
  await admin.connect();
  try {
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
  } finally {
    await admin.end();
  }
}, 30_000);

describe("tenant row security", () => {
  test("the login role is a plain table owner, not a superuser", async () => {
    const facts = await readTenantRoleFacts(ownerPool);
    expect(facts).toMatchObject({
      login_role: ownerRole,
      is_superuser: false,
      can_create_role: false,
      role_exists: true,
      can_assume_role: true,
      role_bypasses_row_security: false,
      scheme_applied: true,
      grants_present: true,
    });
    expect(await tenantRolePreflight(ownerPool)).toMatchObject({
      verdict: "ready",
      blocking: false,
    });
  });

  test("every listed table has row security without force and one policy for the tenant role", async () => {
    const tables = await ownerPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'subkit' AND c.relrowsecurity ORDER BY c.relname`,
    );
    expect(tables.rows.map((row) => row.relname)).toEqual(SCOPED_TABLES);
    expect(tables.rows.every((row) => !row.relforcerowsecurity)).toBe(true);
    const policies = await ownerPool.query<{ tablename: string; roles: string }>(
      `SELECT tablename, roles::text AS roles FROM pg_policies
        WHERE schemaname = 'subkit' ORDER BY tablename`,
    );
    expect(policies.rows).toEqual(
      SCOPED_TABLES.map((tablename) => ({ tablename, roles: `{${TENANT_ROLE}}` })),
    );
  });

  test("a scoped select without a tenant filter returns only its own tenant", async () => {
    const names = await withTenantScope(owner, tenantA, async (tx) =>
      // tenant-filter:exempt — proves the policy filters when the query forgets the tenant
      (await tx.select({ name: vaultItems.name }).from(vaultItems)).map((row) => row.name),
    );
    expect(names).toEqual(["a-token"]);
  });

  test("a scoped write cannot reach another tenant", async () => {
    expect(
      await failureCode(() =>
        withTenantScope(owner, tenantA, (tx) =>
          tx.insert(vaultItems).values(sealedItem(tenantB, "smuggled")),
        ),
      ),
    ).toBe("42501");
    const touched = await withTenantScope(owner, tenantA, (tx) =>
      tx
        .update(vaultItems)
        .set({ description: "overwritten" })
        .where(eq(vaultItems.tenant_id, tenantB))
        .returning({ id: vaultItems.id }),
    );
    expect(touched).toEqual([]);
    const removed = await withTenantScope(owner, tenantA, (tx) =>
      tx.delete(vaultItems).where(eq(vaultItems.tenant_id, tenantB)).returning({
        id: vaultItems.id,
      }),
    );
    expect(removed).toEqual([]);
    expect(
      await failureCode(() =>
        withTenantScope(owner, tenantA, (tx) =>
          tx
            .update(vaultItems)
            .set({ tenant_id: tenantB })
            .where(eq(vaultItems.tenant_id, tenantA)),
        ),
      ),
    ).toBe("42501");
  });

  test("the tenant role without a tenant sees nothing and cannot insert", async () => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${TENANT_ROLE}`);
      const seen = await client.query("SELECT count(*)::int AS n FROM subkit.vault_items");
      expect(seen.rows[0]).toEqual({ n: 0 });
      await client.query("SAVEPOINT attempt");
      expect(
        await failureCode(() =>
          client.query(
            "INSERT INTO subkit.vault_items (tenant_id, name, environment, mode, ciphertext, iv, auth_tag) VALUES ($1, 'orphan', 'dev', 'bearer', 'x', 'x', 'x')",
            [tenantA],
          ),
        ),
      ).toBe("42501");
      await client.query("ROLLBACK TO SAVEPOINT attempt");
      await client.query("SELECT set_config('subkit.tenant_id', '', true)");
      const blank = await client.query("SELECT count(*)::int AS n FROM subkit.vault_items");
      expect(blank.rows[0]).toEqual({ n: 0 });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  test("a scope refuses anything but a tenant uuid before touching the database", async () => {
    await expect(withTenantScope(owner, "", async () => 1)).rejects.toThrow(TypeError);
    await expect(
      withTenantScope(owner, `${tenantA}'; RESET ROLE; --`, async () => 1),
    ).rejects.toThrow(TypeError);
  });

  test("the owner path without a scope sees and changes every tenant", async () => {
    // tenant-filter:exempt — proves an unscoped owner sweep still spans tenants
    const rows = await owner.select({ tenant_id: vaultItems.tenant_id }).from(vaultItems);
    expect(new Set(rows.map((row) => row.tenant_id))).toEqual(new Set([tenantA, tenantB]));
    const swept = await ownerPool.query(
      "UPDATE subkit.vault_items SET last_used_at = now() RETURNING tenant_id",
    );
    expect(swept.rowCount).toBe(rows.length);
  });

  test("the role and tenant are gone after commit on a single-connection pool", async () => {
    expect(ownerPool.options.max).toBe(1);
    await withTenantScope(owner, tenantA, async (tx) => {
      const inside = await tx.execute<{ acting: string; tenant: string }>(
        sql`SELECT current_user AS acting, current_setting('subkit.tenant_id', true) AS tenant`,
      );
      expect(inside.rows[0]).toEqual({ acting: TENANT_ROLE, tenant: tenantA });
    });
    const state = await sessionState();
    expect(state?.acting).toBe(ownerRole);
    expect(state?.role).toBe("none");
    expect(state?.tenant ?? "").toBe("");
    const visible = await ownerPool.query("SELECT count(*)::int AS n FROM subkit.vault_items");
    expect(visible.rows[0]?.n).toBeGreaterThanOrEqual(2);
  });

  test("the role and tenant are gone after a rollback", async () => {
    await expect(
      withTenantScope(owner, tenantA, async () => {
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    const state = await sessionState();
    expect(state?.acting).toBe(ownerRole);
    expect(state?.tenant ?? "").toBe("");
  });

  test("a scope inside an owner transaction hands the owner role back", async () => {
    await owner.transaction(async (outer) => {
      const scoped = await withTenantScope(
        outer,
        tenantA,
        async (tx) =>
          // tenant-filter:exempt — counts what the policy lets through
          (await tx.select({ id: vaultItems.id }).from(vaultItems)).length,
      );
      expect(scoped).toBe(1);
      const after = await outer.execute<{ acting: string; tenant: string | null }>(
        sql`SELECT current_user AS acting, current_setting('subkit.tenant_id', true) AS tenant`,
      );
      expect(after.rows[0]?.acting).toBe(ownerRole);
      expect(after.rows[0]?.tenant ?? "").toBe("");
      // tenant-filter:exempt — the owner transaction spans tenants again
      const all = await outer.select({ tenant_id: vaultItems.tenant_id }).from(vaultItems);
      expect(new Set(all.map((row) => row.tenant_id)).size).toBe(2);

      await withTenantScope(outer, tenantA, async () => {
        throw new Error("inner failure");
      }).catch(() => {});
      const recovered = await outer.execute<{ acting: string }>(sql`SELECT current_user AS acting`);
      expect(recovered.rows[0]?.acting).toBe(ownerRole);
    });
  });

  test("a scope inside another scope returns to the outer tenant", async () => {
    await withTenantScope(owner, tenantA, async (outer) => {
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

  test("vault and credential services work through the scope and stay inside their tenant", async () => {
    const created = await createVaultItem(owner, {
      tenant_id: tenantA,
      actor: null,
      viewer: ADMIN_VIEWER,
      kind: "secret",
      name: "service-token",
      scope: "workspace",
      environment: "dev",
      description: null,
      value: { kind: "secret", token: "fixture-row-security-token" },
    });
    const handle = { scope: "workspace" as const, name: "service-token", field: null };
    expect(
      await resolveVaultHandle(owner, {
        tenant_id: tenantA,
        environment: "dev",
        user_id: null,
        handle,
      }),
    ).toMatchObject({ ok: true, secret: { value: "fixture-row-security-token" } });
    expect(
      await resolveVaultHandle(owner, {
        tenant_id: tenantB,
        environment: "dev",
        user_id: null,
        handle,
      }),
    ).toMatchObject({ ok: false, code: "key_not_found" });
    expect(
      await revealVaultItem(owner, {
        tenant_id: tenantA,
        id: created.id,
        actor: null,
        viewer: ADMIN_VIEWER,
      }),
    ).toMatchObject({ values: { token: "fixture-row-security-token" } });
    await expect(
      revealVaultItem(owner, {
        tenant_id: tenantB,
        id: created.id,
        actor: null,
        viewer: ADMIN_VIEWER,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const listed = await listVaultItems(owner, tenantB, ADMIN_VIEWER);
    expect(listed.map((item) => item.name)).toEqual(["b-token"]);

    const connector = await seedConnector(owner, { tenant_id: tenantA, auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: tenantA,
        connector_id: connector.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "fixture-connector-token" },
        actor_id: null,
      },
      owner,
    );
    const own = await getCredentialForConnector(tenantA, connector.id, "dev", owner);
    expect(own?.value).toMatchObject({ mode: "bearer", token: "fixture-connector-token" });
    expect(await getCredentialForConnector(tenantB, connector.id, "dev", owner)).toBeNull();
    const state = await sessionState();
    expect(state?.acting).toBe(ownerRole);
  });

  test("the tenant role cannot call the definer functions closed to the public", async () => {
    expect(
      await failureCode(() =>
        withTenantScope(owner, tenantA, (tx) =>
          tx.execute(sql`SELECT * FROM subkit.vault_maintenance_status()`),
        ),
      ),
    ).toBe("42501");
    const granted = await ownerPool.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('${TENANT_ROLE}', p.oid, 'EXECUTE') AS allowed
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'subkit'
          AND p.proname IN ('vault_maintenance_apply', 'vault_maintenance_authorize',
                            'vault_maintenance_snapshot', 'vault_maintenance_status')`,
    );
    expect(granted.rows.length).toBe(4);
    expect(granted.rows.every((row) => !row.allowed)).toBe(true);
  });

  test("owner schema changes keep working and new tables reach the tenant role", async () => {
    await ownerPool.query("CREATE TABLE subkit.row_security_probe (id integer)");
    try {
      const granted = await ownerPool.query<{ allowed: boolean }>(
        `SELECT has_table_privilege('${TENANT_ROLE}', 'subkit.row_security_probe', 'INSERT') AS allowed`,
      );
      expect(granted.rows[0]?.allowed).toBe(true);
      await ownerPool.query("ALTER TABLE subkit.vault_items ADD COLUMN row_security_probe text");
      await ownerPool.query("ALTER TABLE subkit.vault_items DROP COLUMN row_security_probe");
    } finally {
      await ownerPool.query("DROP TABLE subkit.row_security_probe");
    }
  });

  test("a role created after the migration takes effect on the next start", async () => {
    for (const table of SCOPED_TABLES) {
      await ownerPool.query(`DROP POLICY "tenant_scope" ON subkit.${table}`);
      await ownerPool.query(`ALTER TABLE subkit.${table} DISABLE ROW LEVEL SECURITY`);
    }
    await ownerPool.query(`REVOKE USAGE ON SCHEMA subkit FROM ${TENANT_ROLE}`);
    expect(await readTenantRoleFacts(ownerPool)).toMatchObject({
      scheme_applied: false,
      grants_present: false,
    });

    expect(await ensureTenantRowSecurity(ownerPool, rowSecuritySql)).toMatchObject({
      verdict: "ready",
    });

    const policies = await ownerPool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_policies WHERE schemaname = 'subkit' ORDER BY tablename",
    );
    expect(policies.rows.map((row) => row.tablename)).toEqual(SCOPED_TABLES);
    const names = await withTenantScope(owner, tenantB, async (tx) =>
      // tenant-filter:exempt — proves the reapplied policy filters a query without a tenant
      (await tx.select({ name: vaultItems.name }).from(vaultItems)).map((row) => row.name),
    );
    expect(names).toEqual(["b-token"]);
  });
});
