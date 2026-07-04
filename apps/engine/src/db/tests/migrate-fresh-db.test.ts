// End-to-end check that a fresh database, given only `runMigrations(db)`,
// reaches the schema state the rest of the engine expects.
//
// A "schema mismatch the engine quietly logs and keeps going" is the
// failure this guards against; the test fails loudly if a future
// refactor breaks the embedded-bundle path on a clean DB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { listEmbeddedMigrations, runMigrations } from "../migrate.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  // createTestDb already runs `runMigrations(db)`; this gives us a
  // fully-migrated DB to inspect.
  ctx = await createTestDb("migrate_fresh_db");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

interface ExistsRow {
  rows: Array<{ exists: boolean }>;
}

async function tableExists(name: string): Promise<boolean> {
  const r = (await ctx.db.execute(
    sql`SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${name}
        ) AS "exists"`,
  )) as unknown as ExistsRow;
  return Boolean(r.rows?.[0]?.exists);
}

describe("runMigrations on a fresh database", () => {
  test("creates the workflow_waits table", async () => {
    expect(await tableExists("workflow_waits")).toBe(true);
  });

  test("creates every other top-level expected table", async () => {
    const expected = [
      "tenants",
      "users",
      "system_accounts",
      "api_keys",
      "skills",
      "connectors",
      "workflows",
      "executions",
      "audit_log",
      "credentials",
    ];
    for (const t of expected) {
      expect(await tableExists(t)).toBe(true);
    }
  });

  test("drizzle.__drizzle_migrations row count equals embedded entry count", async () => {
    const r = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows?.[0]?.n).toBe(listEmbeddedMigrations().length);
  });

  test("re-running runMigrations is a no-op", async () => {
    const before = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    const report = await runMigrations(ctx.db);
    expect(report.applied).toBe(0);
    expect(report.skipped).toBe(listEmbeddedMigrations().length);
    const after = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(after.rows?.[0]?.n).toBe(before.rows?.[0]?.n);
  });

  // Secret-by-reference CHECK guard. Insert a minimal tenant, then
  // assert auth_config inserts that put canonical secret keys at the
  // root are rejected.
  test("mcp_servers rejects inline secrets in auth_config", async () => {
    const tenant = (await ctx.db.execute(
      sql`INSERT INTO tenants (id, slug, display_name) VALUES (gen_random_uuid(), 'mcp-secret-check', 'mcp secret check') RETURNING id::text AS id`,
    )) as unknown as { rows: Array<{ id: string }> };
    const tenant_id = tenant.rows?.[0]?.id;
    if (!tenant_id) throw new Error("tenant insert failed");
    const cleanup = sql`DELETE FROM tenants WHERE id = ${tenant_id}`;
    try {
      // Accept-path: secret-by-reference via token_ref.
      await ctx.db.execute(sql`
        INSERT INTO mcp_servers (tenant_id, name, namespace, transport, url, auth_config)
        VALUES (
          ${tenant_id}::uuid, 'ok', 'ns-ok', 'http', 'https://example.test/mcp',
          '{"kind":"bearer","token_ref":"cred-123"}'::jsonb
        )
      `);
      // Reject-path: inline client_secret at the root.
      const denied = [
        '{"client_secret":"shhh"}',
        '{"password":"hunter2"}',
        '{"api_key":"ak_123"}',
        '{"access_token":"at_123"}',
        '{"refresh_token":"rt_123"}',
      ];
      let nsCounter = 0;
      for (const payload of denied) {
        let threw = false;
        try {
          await ctx.db.execute(
            sql.raw(`
            INSERT INTO mcp_servers (tenant_id, name, namespace, transport, url, auth_config)
            VALUES (
              '${tenant_id}'::uuid, 'no', 'ns-no-${++nsCounter}',
              'http', 'https://example.test/mcp', '${payload}'::jsonb
            )
          `),
          );
        } catch (err) {
          threw = true;
          // Drizzle wraps the pg error as `cause`; the constraint name
          // only appears on the inner message.
          const inner = (err as { cause?: { message?: string } }).cause?.message ?? "";
          expect(inner).toContain("mcp_servers_auth_config_no_inline_secrets_check");
        }
        expect(threw).toBe(true);
      }
    } finally {
      await ctx.db.execute(cleanup);
    }
  });

  // Namespace shape CHECK guard. Forbid `__` runs and leading/trailing
  // punctuation.
  test("mcp_servers rejects malformed namespaces", async () => {
    const tenant = (await ctx.db.execute(
      sql`INSERT INTO tenants (id, slug, display_name) VALUES (gen_random_uuid(), 'mcp-namespace-check', 'mcp namespace check') RETURNING id::text AS id`,
    )) as unknown as { rows: Array<{ id: string }> };
    const tenant_id = tenant.rows?.[0]?.id;
    if (!tenant_id) throw new Error("tenant insert failed");
    const cleanup = sql`DELETE FROM tenants WHERE id = ${tenant_id}`;
    try {
      const bad = ["foo__bar", "-leading", "trailing_", "_leading", "trailing-"];
      for (const ns of bad) {
        let threw = false;
        try {
          await ctx.db.execute(
            sql.raw(`
            INSERT INTO mcp_servers (tenant_id, name, namespace, transport, url)
            VALUES (
              '${tenant_id}'::uuid, 'bad', '${ns}', 'http', 'https://example.test/mcp'
            )
          `),
          );
        } catch (err) {
          threw = true;
          const inner = (err as { cause?: { message?: string } }).cause?.message ?? "";
          expect(inner).toContain("mcp_servers_namespace_shape_check");
        }
        expect(threw).toBe(true);
      }
      // Accept-path: well-formed namespace.
      await ctx.db.execute(sql`
        INSERT INTO mcp_servers (tenant_id, name, namespace, transport, url)
        VALUES (${tenant_id}::uuid, 'ok', 'notion-mcp_v2', 'http', 'https://example.test/mcp')
      `);
    } finally {
      await ctx.db.execute(cleanup);
    }
  });
});
