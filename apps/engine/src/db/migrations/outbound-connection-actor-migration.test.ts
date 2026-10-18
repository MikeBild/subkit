import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { runMigrations } from "../migrate.ts";
import { outboundConnectionStarts, systemAccounts, users } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find(
  (item) => item.tag === "0104_outbound_connection_owner_backfill",
);
const nullableUserIdMigration = EMBEDDED_MIGRATIONS.find(
  (item) => item.tag === "0105_classy_edwin_jarvis",
);

test(
  "preserves unknown actors, restores eligible owners, and migrates user_id to nullable",
  async () => {
    if (!migration || !nullableUserIdMigration)
      throw new Error("outbound connection actor migrations are not embedded");
    const ctx = await createTestDb("connection_actor_migration", { upToIdx: migration.idx - 1 });
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"connection-actor-migration"}, ${"Connection actor migration"}) RETURNING id
  `);
      if (!tenant) throw new Error("test tenant was not created");
      const {
        rows: [otherTenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"connection-actor-migration-other"}, ${"Connection actor migration other"}) RETURNING id
  `);
      if (!otherTenant) throw new Error("second test tenant was not created");
      const [user] = await ctx.db
        .insert(users)
        .values({
          tenant_id: tenant.id,
          email: "connection-actor-migration@test.local",
          role_id: await builtinRoleId(ctx.db, "member"),
        })
        .returning({ id: users.id });
      if (!user) throw new Error("test user was not created");
      const [collisionUser] = await ctx.db
        .insert(users)
        .values({
          tenant_id: tenant.id,
          email: "connection-actor-collision@test.local",
          role_id: await builtinRoleId(ctx.db, "member"),
        })
        .returning({ id: users.id });
      if (!collisionUser) throw new Error("collision user was not created");
      const [otherTenantUser] = await ctx.db
        .insert(users)
        .values({
          tenant_id: otherTenant.id,
          email: "connection-actor-other-tenant@test.local",
          role_id: await builtinRoleId(ctx.db, "member"),
        })
        .returning({ id: users.id });
      if (!otherTenantUser) throw new Error("second-tenant user was not created");
      await ctx.db.insert(systemAccounts).values({
        id: collisionUser.id,
        tenant_id: tenant.id,
        name: "connection-actor-collision",
      });

      await ctx.pool.query(
        `INSERT INTO outbound_connection_starts
          (tenant_id, user_id, state_sha256, code_verifier, redirect_uri, name, base_url,
           issuer, authorization_endpoint, token_endpoint, client_id, scopes, expires_at)
         VALUES ($1, $2, 'historical-state', 'verifier', 'https://engine.test/callback',
           'historical', 'https://provider.test', 'https://provider.test',
           'https://provider.test/authorize', 'https://provider.test/token', 'client',
           '[]'::jsonb, now() + interval '5 minutes')`,
        [tenant.id, user.id],
      );
      await ctx.pool.query(
        `INSERT INTO outbound_connection_starts
          (tenant_id, user_id, state_sha256, code_verifier, redirect_uri, name, base_url,
           issuer, authorization_endpoint, token_endpoint, client_id, scopes, expires_at)
         VALUES ($1, $2, 'historical-cross-tenant-state', 'verifier',
           'https://engine.test/callback', 'historical-cross-tenant',
           'https://provider.test', 'https://provider.test',
           'https://provider.test/authorize', 'https://provider.test/token', 'client',
           '[]'::jsonb, now() + interval '5 minutes')`,
        [tenant.id, otherTenantUser.id],
      );
      await ctx.pool.query(
        `INSERT INTO outbound_connection_starts
          (tenant_id, user_id, state_sha256, code_verifier, redirect_uri, name, base_url,
           issuer, authorization_endpoint, token_endpoint, client_id, scopes, expires_at)
         VALUES ($1, $2, 'historical-identity-collision-state', 'verifier',
           'https://engine.test/callback', 'historical-identity-collision',
           'https://provider.test', 'https://provider.test',
           'https://provider.test/authorize', 'https://provider.test/token', 'client',
           '[]'::jsonb, now() + interval '5 minutes')`,
        [tenant.id, collisionUser.id],
      );
      await ctx.pool.query(
        `INSERT INTO outbound_connection_starts
          (tenant_id, user_id, state_sha256, code_verifier, redirect_uri, name, base_url,
           issuer, authorization_endpoint, token_endpoint, client_id, scopes, expires_at, consumed_at)
         VALUES ($1, $2, 'historical-consumed-state', 'verifier', 'https://engine.test/callback',
           'historical-consumed', 'https://provider.test', 'https://provider.test',
           'https://provider.test/authorize', 'https://provider.test/token', 'client',
           '[]'::jsonb, now() + interval '5 minutes', now())`,
        [tenant.id, user.id],
      );

      expect((await runMigrations(ctx.db, [migration], true)).applied).toBe(1);
      const pendingRows = await ctx.db
        .select({
          actor_type: outboundConnectionStarts.actor_type,
          actor_id: outboundConnectionStarts.actor_id,
          owner_user_id: outboundConnectionStarts.owner_user_id,
          state_sha256: outboundConnectionStarts.state_sha256,
        })
        .from(outboundConnectionStarts)
        .where(eq(outboundConnectionStarts.tenant_id, tenant.id));
      expect(pendingRows).toEqual(
        expect.arrayContaining([
          {
            actor_type: "unknown",
            actor_id: null,
            owner_user_id: user.id,
            state_sha256: "historical-state",
          },
          {
            actor_type: "unknown",
            actor_id: null,
            owner_user_id: null,
            state_sha256: "historical-cross-tenant-state",
          },
          {
            actor_type: "unknown",
            actor_id: null,
            owner_user_id: null,
            state_sha256: "historical-consumed-state",
          },
          {
            actor_type: "unknown",
            actor_id: null,
            owner_user_id: null,
            state_sha256: "historical-identity-collision-state",
          },
        ]),
      );

      await expect(
        (async () => {
          await ctx.db
            .update(outboundConnectionStarts)
            .set({ actor_id: user.id })
            .where(eq(outboundConnectionStarts.state_sha256, "historical-state"))
            .returning();
        })(),
      ).rejects.toThrow();
      await expect(
        (async () => {
          await ctx.db
            .update(outboundConnectionStarts)
            .set({ actor_type: "invalid" as never })
            .where(eq(outboundConnectionStarts.state_sha256, "historical-state"))
            .returning();
        })(),
      ).rejects.toThrow();
      const [constrainedRow] = await ctx.db
        .select({
          actor_type: outboundConnectionStarts.actor_type,
          actor_id: outboundConnectionStarts.actor_id,
        })
        .from(outboundConnectionStarts)
        .where(eq(outboundConnectionStarts.state_sha256, "historical-state"));
      expect(constrainedRow).toEqual({ actor_type: "unknown", actor_id: null });

      expect((await runMigrations(ctx.db, [nullableUserIdMigration], true)).applied).toBe(1);
      await ctx.db
        .update(outboundConnectionStarts)
        .set({ user_id: null })
        .where(eq(outboundConnectionStarts.state_sha256, "historical-state"));
      const [actorlessStart] = await ctx.db
        .select({ user_id: outboundConnectionStarts.user_id })
        .from(outboundConnectionStarts)
        .where(eq(outboundConnectionStarts.state_sha256, "historical-state"));
      expect(actorlessStart).toEqual({ user_id: null });
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
