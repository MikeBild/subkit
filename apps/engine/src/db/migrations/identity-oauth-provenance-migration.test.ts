import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { systemAccounts } from "../schema/index.ts";
import { mcpOauthGrants } from "../schema/mcp_oauth.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";

test(
  "identity provenance constraints guard API key creators, audit actors, and OAuth grant identity",
  async () => {
    const ctx = await createTestDb("identity_oauth_provenance");
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"identity-oauth-provenance"}, ${"Identity provenance"}) RETURNING id
  `);
      if (!tenant) throw new Error("test tenant was not created");
      const roleId = await builtinRoleId(ctx.db, "member");
      const { rows: userRows } = await ctx.pool.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, role_id)
         VALUES ($1, 'identity-provenance@test.local', $2) RETURNING id`,
        [tenant.id, roleId],
      );
      const user = userRows[0];
      const { rows: otherUserRows } = await ctx.pool.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, role_id)
         VALUES ($1, 'identity-provenance-other@test.local', $2) RETURNING id`,
        [tenant.id, roleId],
      );
      const otherUser = otherUserRows[0];
      if (!user || !otherUser) throw new Error("test users were not created");
      const [systemAccount] = await ctx.db
        .insert(systemAccounts)
        .values({ tenant_id: tenant.id, name: "identity-provenance-system" })
        .returning({ id: systemAccounts.id });
      if (!systemAccount) throw new Error("test system account was not created");

      await ctx.pool.query(
        `INSERT INTO api_keys (tenant_id, prefix, token_sha256, scopes, creator_kind, creator_id)
         VALUES ($1, 'user-created-key', 'user-created-sha256', '[]'::jsonb, 'user', $2),
                ($1, 'system-created-key', 'system-created-sha256', '[]'::jsonb, 'system', NULL),
                ($1, 'account-created-key', 'account-created-sha256', '[]'::jsonb,
                 'system_account', $3),
                ($1, 'unattributed-key', 'unattributed-sha256', '[]'::jsonb, NULL, NULL)`,
        [tenant.id, user.id, systemAccount.id],
      );
      await expect(
        ctx.pool.query(
          `INSERT INTO api_keys (tenant_id, prefix, token_sha256, scopes, creator_kind, creator_id)
           VALUES ($1, 'invalid-user-key', 'invalid-user-sha256', '[]'::jsonb, 'user', NULL)`,
          [tenant.id],
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `INSERT INTO api_keys (tenant_id, prefix, token_sha256, scopes, creator_id)
           VALUES ($1, 'invalid-unknown-key', 'invalid-unknown-sha256', '[]'::jsonb, $2)`,
          [tenant.id, user.id],
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `INSERT INTO api_keys (tenant_id, prefix, token_sha256, scopes, creator_kind)
           VALUES ($1, 'invalid-account-key', 'invalid-account-sha256', '[]'::jsonb,
             'system_account')`,
          [tenant.id],
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `INSERT INTO api_keys (tenant_id, prefix, token_sha256, scopes, creator_kind)
           VALUES ($1, 'invalid-unknown-kind-key', 'invalid-unknown-kind-sha256',
             '[]'::jsonb, 'unknown')`,
          [tenant.id],
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `INSERT INTO api_keys (tenant_id, prefix, token_sha256, scopes, creator_kind, creator_id)
           VALUES ($1, 'invalid-system-key', 'invalid-system-sha256', '[]'::jsonb,
             'system', $2)`,
          [tenant.id, user.id],
        ),
      ).rejects.toThrow();

      await ctx.pool.query(
        `INSERT INTO audit_log
          (id, tenant_id, actor_type, action, resource_type, result)
         VALUES ('00000000-0000-0000-0000-000000000102', $1, 'unknown',
           'unknown.identity', 'user', 'success')`,
        [tenant.id],
      );
      await ctx.pool.query(
        `INSERT INTO audit_log
          (id, tenant_id, actor_type, actor_id, action, resource_type, result)
         VALUES ('00000000-0000-0000-0000-000000000105', $1, 'system_account', $2,
           'system_account.identity', 'user', 'success'),
                ('00000000-0000-0000-0000-000000000106', $1, 'system', NULL,
           'system.identity', 'user', 'success')`,
        [tenant.id, systemAccount.id],
      );
      await expect(
        ctx.pool.query(
          `INSERT INTO audit_log
            (id, tenant_id, actor_type, actor_id, action, resource_type, result)
           VALUES ('00000000-0000-0000-0000-000000000103', $1, 'unknown', $2,
             'invalid.identity', 'user', 'success')`,
          [tenant.id, user.id],
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `INSERT INTO audit_log
            (id, tenant_id, actor_type, action, resource_type, result)
           VALUES ('00000000-0000-0000-0000-000000000104', $1, 'unknown_actor',
             'invalid.identity', 'user', 'success')`,
          [tenant.id],
        ),
      ).rejects.toThrow();

      const [grant] = await ctx.db
        .insert(mcpOauthGrants)
        .values({ tenant_id: tenant.id, client_id: "identity-oauth-client", user_id: user.id })
        .returning({ id: mcpOauthGrants.id });
      if (!grant) throw new Error("test OAuth grant was not created");
      const expiresAt = new Date(FROZEN_NOW + 60_000);
      await ctx.pool.query(
        `INSERT INTO mcp_oauth_access_tokens
          (tenant_id, client_id, user_id, grant_id, prefix, token_sha256, scope, expires_at)
         VALUES ($1, 'identity-oauth-client', $2, $3, 'identity-access',
           'identity-access-sha256', 'mcp:read', $4)`,
        [tenant.id, user.id, grant.id, expiresAt],
      );
      await ctx.pool.query(
        `INSERT INTO mcp_oauth_refresh_tokens
          (tenant_id, client_id, user_id, grant_id, prefix, token_sha256, scope, expires_at)
         VALUES ($1, 'identity-oauth-client', $2, $3, 'identity-refresh',
           'identity-refresh-sha256', 'mcp:read', $4)`,
        [tenant.id, user.id, grant.id, expiresAt],
      );
      await expect(
        ctx.pool.query(
          `INSERT INTO mcp_oauth_access_tokens
            (tenant_id, client_id, user_id, grant_id, prefix, token_sha256, scope, expires_at)
           VALUES ($1, 'wrong-client', $2, $3, 'identity-wrong-client',
             'identity-wrong-client-sha256', 'mcp:read', $4)`,
          [tenant.id, user.id, grant.id, expiresAt],
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `INSERT INTO mcp_oauth_access_tokens
            (tenant_id, client_id, user_id, grant_id, prefix, token_sha256, scope, expires_at)
           VALUES ($1, 'identity-oauth-client', $2, $3, 'identity-wrong-user',
             'identity-wrong-user-sha256', 'mcp:read', $4)`,
          [tenant.id, otherUser.id, grant.id, expiresAt],
        ),
      ).rejects.toThrow();
      await expect(
        ctx.pool.query(
          `INSERT INTO mcp_oauth_refresh_tokens
            (tenant_id, client_id, user_id, grant_id, prefix, token_sha256, scope, expires_at)
           VALUES ($1, 'identity-oauth-client', $2, $3, 'identity-wrong-refresh-user',
             'identity-wrong-refresh-user-sha256', 'mcp:read', $4)`,
          [tenant.id, otherUser.id, grant.id, expiresAt],
        ),
      ).rejects.toThrow();
      await ctx.pool.query(`DELETE FROM mcp_oauth_grants WHERE id = $1`, [grant.id]);
      const cascadedTokens = await ctx.pool.query(
        `SELECT token_sha256 FROM mcp_oauth_access_tokens
          WHERE token_sha256 = 'identity-access-sha256'
         UNION ALL
         SELECT token_sha256 FROM mcp_oauth_refresh_tokens
          WHERE token_sha256 = 'identity-refresh-sha256'`,
      );
      expect(cascadedTokens.rows).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
