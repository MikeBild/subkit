import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { outboundConnectionStarts } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";

test(
  "an outbound connection start keeps its actor pair constrained and allows a missing user",
  async () => {
    const ctx = await createTestDb("connection_actor_migration");
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"connection-actor-migration"}, ${"Connection actor migration"}) RETURNING id
  `);
      if (!tenant) throw new Error("test tenant was not created");
      const {
        rows: [user],
      } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (tenant_id, email, role_id)
        VALUES (${tenant.id}, ${"connection-actor-migration@test.local"}, ${await builtinRoleId(ctx.db, "member")})
        RETURNING id
      `);
      if (!user) throw new Error("test user was not created");
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
