import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { runMigrations } from "../migrate.ts";
import { systemAccounts, users } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const actorColumnsMigration = EMBEDDED_MIGRATIONS.find((item) => item.tag === "0102_lazy_hitman");
const actorChecksMigration = EMBEDDED_MIGRATIONS.find(
  (item) => item.tag === "0103_deep_wrecking_crew",
);

test(
  "adds actor defaults, owner deletion behavior, and actor-type database constraints",
  async () => {
    if (!actorColumnsMigration || !actorChecksMigration)
      throw new Error("outbound connection actor migrations are not embedded");
    const ctx = await createTestDb("connection_actor_contract", {
      upToIdx: actorColumnsMigration.idx - 1,
    });
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"connection-actor-contract"}, ${"Connection actor contract"}) RETURNING id
  `);
      if (!tenant) throw new Error("test tenant was not created");
      const {
        rows: [user],
      } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (tenant_id, email, role_id)
        VALUES (${tenant.id}, ${"connection-actor-contract@test.local"}, ${await builtinRoleId(ctx.db, "member")})
        RETURNING id
      `);
      if (!user) throw new Error("test user was not created");
      const {
        rows: [actorUser],
      } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (tenant_id, email, role_id)
        VALUES (${tenant.id}, ${"connection-actor-contract-actor@test.local"}, ${await builtinRoleId(ctx.db, "member")})
        RETURNING id
      `);
      if (!actorUser) throw new Error("test actor user was not created");
      const [systemAccount] = await ctx.db
        .insert(systemAccounts)
        .values({ tenant_id: tenant.id, name: "connection-actor-contract-actor" })
        .returning({ id: systemAccounts.id });
      if (!systemAccount) throw new Error("test system account was not created");

      await ctx.pool.query(
        `INSERT INTO outbound_connection_starts
          (tenant_id, user_id, state_sha256, code_verifier, redirect_uri, name, base_url,
           issuer, authorization_endpoint, token_endpoint, client_id, scopes, expires_at)
         VALUES ($1, $2, 'before-actor-columns', 'verifier', 'https://engine.test/callback',
           'legacy', 'https://provider.test', 'https://provider.test',
           'https://provider.test/authorize', 'https://provider.test/token', 'client',
           '[]'::jsonb, '2030-01-01T00:00:00Z')`,
        [tenant.id, user.id],
      );

      expect((await runMigrations(ctx.db, [actorColumnsMigration], true)).applied).toBe(1);
      const upgraded = await ctx.pool.query(
        `SELECT actor_type, actor_id, owner_user_id
           FROM outbound_connection_starts
          WHERE state_sha256 = 'before-actor-columns'`,
      );
      expect(upgraded.rows).toEqual([
        { actor_type: "unknown", actor_id: null, owner_user_id: null },
      ]);

      await ctx.pool.query(
        `UPDATE outbound_connection_starts
            SET owner_user_id = $1
          WHERE state_sha256 = 'before-actor-columns'`,
        [user.id],
      );
      await ctx.db.delete(users).where(eq(users.id, user.id));
      const ownerAfterDelete = await ctx.pool.query(
        `SELECT owner_user_id FROM outbound_connection_starts
          WHERE state_sha256 = 'before-actor-columns'`,
      );
      expect(ownerAfterDelete.rows).toEqual([{ owner_user_id: null }]);

      expect((await runMigrations(ctx.db, [actorChecksMigration], true)).applied).toBe(1);
      await expect(
        ctx.pool.query(
          `UPDATE outbound_connection_starts SET actor_id = '00000000-0000-0000-0000-000000000001'
            WHERE state_sha256 = 'before-actor-columns'`,
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `UPDATE outbound_connection_starts SET actor_type = 'unknown-invalid'
            WHERE state_sha256 = 'before-actor-columns'`,
        ),
      ).rejects.toThrow();

      await ctx.pool.query(
        `UPDATE outbound_connection_starts SET actor_type = 'user', actor_id = $1
          WHERE state_sha256 = 'before-actor-columns'`,
        [actorUser.id],
      );
      const typedActor = await ctx.pool.query(
        `SELECT actor_type, actor_id FROM outbound_connection_starts
          WHERE state_sha256 = 'before-actor-columns'`,
      );
      expect(typedActor.rows).toEqual([{ actor_type: "user", actor_id: actorUser.id }]);
      await ctx.pool.query(
        `UPDATE outbound_connection_starts SET actor_type = 'system_account', actor_id = $1
          WHERE state_sha256 = 'before-actor-columns'`,
        [systemAccount.id],
      );
      const typedSystemActor = await ctx.pool.query(
        `SELECT actor_type, actor_id FROM outbound_connection_starts
          WHERE state_sha256 = 'before-actor-columns'`,
      );
      expect(typedSystemActor.rows).toEqual([
        { actor_type: "system_account", actor_id: systemAccount.id },
      ]);
      expect(
        (await runMigrations(ctx.db, [actorColumnsMigration, actorChecksMigration], true)).applied,
      ).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
