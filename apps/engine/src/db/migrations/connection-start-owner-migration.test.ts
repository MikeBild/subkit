import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { runMigrations } from "../migrate.ts";
import { systemAccounts } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

test(
  "a connection start keeps only its owner, and a start that knew its owner only by its user is removed",
  async () => {
    const baseline = EMBEDDED_MIGRATIONS.filter((migration) => migration.idx === 0);
    const ctx = await createTestDb("connection_start_owner", baseline);
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO tenants (slug, display_name)
        VALUES (${"connection-start-owner"}, ${"Connection start owner"}) RETURNING id
      `);
      if (!tenant) throw new Error("test tenant was not created");
      const {
        rows: [user],
      } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (tenant_id, email, role_id)
        VALUES (${tenant.id}, ${"connection-start-owner@test.local"}, ${await builtinRoleId(ctx.db, "member")})
        RETURNING id
      `);
      if (!user) throw new Error("test user was not created");
      const [machine] = await ctx.db
        .insert(systemAccounts)
        .values({ tenant_id: tenant.id, name: "connection-start-owner" })
        .returning({ id: systemAccounts.id });
      if (!machine) throw new Error("test system account was not created");
      const start = (
        state: string,
        values: { user_id: string | null; actor_type: string; actor_id: string | null },
        owner: string | null,
      ) =>
        ctx.pool.query(
          `INSERT INTO outbound_connection_starts
            (tenant_id, user_id, actor_type, actor_id, owner_user_id, state_sha256, code_verifier,
             redirect_uri, name, base_url, issuer, authorization_endpoint, token_endpoint,
             client_id, scopes, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'verifier', 'https://engine.test/callback', $6,
             'https://provider.test', 'https://provider.test', 'https://provider.test/authorize',
             'https://provider.test/token', 'client', '[]'::jsonb, now() + interval '5 minutes')`,
          [tenant.id, values.user_id, values.actor_type, values.actor_id, owner, state],
        );
      await start("unowned", { user_id: user.id, actor_type: "unknown", actor_id: null }, null);
      await start("owned", { user_id: user.id, actor_type: "user", actor_id: user.id }, user.id);
      await start(
        "machine",
        { user_id: null, actor_type: "system_account", actor_id: machine.id },
        null,
      );

      expect(await runMigrations(ctx.db)).toMatchObject({
        applied: EMBEDDED_MIGRATIONS.length - 1,
      });

      const remaining = await ctx.pool.query(
        `SELECT state_sha256, actor_type, actor_id, owner_user_id
           FROM outbound_connection_starts ORDER BY state_sha256`,
      );
      expect(remaining.rows).toEqual([
        {
          state_sha256: "machine",
          actor_type: "system_account",
          actor_id: machine.id,
          owner_user_id: null,
        },
        { state_sha256: "owned", actor_type: "user", actor_id: user.id, owner_user_id: user.id },
      ]);
      const columns = await ctx.pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'subkit'
            AND table_name = 'outbound_connection_starts'
            AND column_name = 'user_id'`,
      );
      expect(columns.rows).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
