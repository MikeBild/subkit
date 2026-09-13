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
          WHERE table_schema = 'subkit' AND table_name = ${name}
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

  test("subkit.__drizzle_migrations row count equals embedded entry count", async () => {
    const r = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM subkit.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows?.[0]?.n).toBe(listEmbeddedMigrations().length);
  });

  test("re-running runMigrations is a no-op", async () => {
    const before = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM subkit.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    const report = await runMigrations(ctx.db);
    expect(report.applied).toBe(0);
    expect(report.skipped).toBe(listEmbeddedMigrations().length);
    const after = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM subkit.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(after.rows?.[0]?.n).toBe(before.rows?.[0]?.n);
  });

  test("leaves no SubKit-owned tables in public", async () => {
    const r = (await ctx.db.execute(sql`
      SELECT count(*)::int AS n
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('tenants', 'users', 'connectors', 'workflows', 'executions', 'workflow_waits')
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows?.[0]?.n).toBe(0);
  });

  // Secret-by-reference CHECK guard, now on `connectors`. The gate moved
  // with the data: an external MCP server is a connector whose driver is
  // `mcp`, and its non-secret auth shape lives at `config.mcp.auth`. The
  // CHECK is scoped to that path rather than the config root because other
  // drivers legitimately carry header NAMES there.
  test("connectors rejects inline secrets under config.mcp.auth", async () => {
    const tenant = (await ctx.db.execute(
      sql`INSERT INTO tenants (id, slug, display_name) VALUES (gen_random_uuid(), 'mcp-secret-check', 'mcp secret check') RETURNING id::text AS id`,
    )) as unknown as { rows: Array<{ id: string }> };
    const tenant_id = tenant.rows?.[0]?.id;
    if (!tenant_id) throw new Error("tenant insert failed");
    const cleanup = sql`DELETE FROM tenants WHERE id = ${tenant_id}`;
    try {
      // Accept-path: the non-secret shape only. The secret lives in the
      // encrypted `credentials` row keyed by connector_id.
      await ctx.db.execute(sql`
        INSERT INTO connectors (tenant_id, slug, display_name, driver, base_url, config)
        VALUES (
          ${tenant_id}::uuid, 'ns-ok', 'ok', 'mcp', 'https://example.test/mcp',
          '{"mcp":{"transport":"http","auth":{"kind":"oauth2","client_id":"public-id"}}}'::jsonb
        )
      `);
      // Accept-path: an HTTP connector may carry the WORD `api_key` as a
      // header name at the config root — the CHECK must not reach it.
      await ctx.db.execute(sql`
        INSERT INTO connectors (tenant_id, slug, display_name, driver, base_url, config)
        VALUES (
          ${tenant_id}::uuid, 'http-ok', 'ok', 'http', 'https://example.test',
          '{"default_headers":{"api_key":"X-Api-Key"}}'::jsonb
        )
      `);
      // Reject-path: a secret VALUE inlined in the mcp auth block.
      const denied = [
        '{"mcp":{"auth":{"client_secret":"shhh"}}}',
        '{"mcp":{"auth":{"password":"hunter2"}}}',
        '{"mcp":{"auth":{"api_key":"ak_123"}}}',
        '{"mcp":{"auth":{"access_token":"at_123"}}}',
        '{"mcp":{"auth":{"refresh_token":"rt_123"}}}',
      ];
      let slugCounter = 0;
      for (const payload of denied) {
        let threw = false;
        try {
          await ctx.db.execute(
            sql.raw(`
            INSERT INTO connectors (tenant_id, slug, display_name, driver, base_url, config)
            VALUES (
              '${tenant_id}'::uuid, 'ns-no-${++slugCounter}', 'no',
              'mcp', 'https://example.test/mcp', '${payload}'::jsonb
            )
          `),
          );
        } catch (err) {
          threw = true;
          // Drizzle wraps the pg error as `cause`; the constraint name
          // only appears on the inner message.
          const inner = (err as { cause?: { message?: string } }).cause?.message ?? "";
          expect(inner).toContain("connectors_mcp_auth_no_inline_secrets_check");
        }
        expect(threw).toBe(true);
      }
    } finally {
      await ctx.db.execute(cleanup);
    }
  });

  // Slug shape CHECK guard, now on `connectors`. Forbid `__` runs and
  // leading/trailing punctuation — the `__` ban is what makes the
  // `mcp_<slug>__<tool>` split point unambiguous, so it applies to EVERY
  // connector, not only the mcp ones.
  test("connectors rejects malformed slugs, whatever the driver", async () => {
    const tenant = (await ctx.db.execute(
      sql`INSERT INTO tenants (id, slug, display_name) VALUES (gen_random_uuid(), 'mcp-namespace-check', 'mcp namespace check') RETURNING id::text AS id`,
    )) as unknown as { rows: Array<{ id: string }> };
    const tenant_id = tenant.rows?.[0]?.id;
    if (!tenant_id) throw new Error("tenant insert failed");
    const cleanup = sql`DELETE FROM tenants WHERE id = ${tenant_id}`;
    try {
      const bad = ["foo__bar", "-leading", "trailing_", "_leading", "trailing-"];
      for (const slug of bad) {
        let threw = false;
        try {
          await ctx.db.execute(
            sql.raw(`
            INSERT INTO connectors (tenant_id, slug, display_name, driver, base_url)
            VALUES (
              '${tenant_id}'::uuid, '${slug}', 'bad', 'http', 'https://example.test'
            )
          `),
          );
        } catch (err) {
          threw = true;
          const inner = (err as { cause?: { message?: string } }).cause?.message ?? "";
          expect(inner).toContain("connectors_slug_shape_check");
        }
        expect(threw).toBe(true);
      }
      // Accept-path: a well-formed slug with a single `_` and a `-`.
      await ctx.db.execute(sql`
        INSERT INTO connectors (tenant_id, slug, display_name, driver, base_url)
        VALUES (${tenant_id}::uuid, 'notion-mcp_v2', 'ok', 'mcp', 'https://example.test/mcp')
      `);
    } finally {
      await ctx.db.execute(cleanup);
    }
  });
});
