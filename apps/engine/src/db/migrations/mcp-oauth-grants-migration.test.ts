import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { builtinRoleId } from "../../rbac/roles.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { runMigrations } from "../migrate.ts";
import { tenants, users } from "../schema/index.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
} from "../schema/mcp_oauth.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find((item) =>
  item.statements.some((statement) => statement.includes('INSERT INTO "mcp_oauth_unknown_grants"')),
);

test(
  "preserves historical OAuth rows as unknown per tenant and client",
  async () => {
    if (!migration) throw new Error("OAuth unknown grant backfill is not embedded");
    const ctx = await createTestDb("mcp_oauth_grants", { upToIdx: migration.idx - 1 });
    try {
      const [tenant] = await ctx.db
        .insert(tenants)
        .values({ slug: "oauth-grants-migration", display_name: "OAuth grants" })
        .returning({ id: tenants.id });
      if (!tenant) throw new Error("test tenant was not created");
      const [otherTenant] = await ctx.db
        .insert(tenants)
        .values({ slug: "oauth-grants-migration-other", display_name: "OAuth grants other" })
        .returning({ id: tenants.id });
      if (!otherTenant) throw new Error("second test tenant was not created");
      const [user] = await ctx.db
        .insert(users)
        .values({
          tenant_id: tenant.id,
          email: "oauth-grants@test.local",
          role_id: await builtinRoleId(ctx.db, "member"),
        })
        .returning({ id: users.id });
      if (!user) throw new Error("test user was not created");
      const [otherTenantUser] = await ctx.db
        .insert(users)
        .values({
          tenant_id: otherTenant.id,
          email: "oauth-grants-other@test.local",
          role_id: await builtinRoleId(ctx.db, "member"),
        })
        .returning({ id: users.id });
      if (!otherTenantUser) throw new Error("second test user was not created");

      const clientIds = ["oauth-grants-access", "oauth-grants-refresh"];
      await ctx.db.insert(mcpOauthClients).values(
        clientIds.map((client_id) => ({
          client_id,
          redirect_uris: ["https://example.test/callback"],
          client_name: client_id,
        })),
      );
      await ctx.db.insert(mcpOauthAccessTokens).values({
        tenant_id: tenant.id,
        client_id: clientIds[0]!,
        user_id: user.id,
        prefix: "wf_mcp_access",
        token_sha256: createHash("sha256").update("legacy-access").digest("hex"),
        scope: "mcp:read",
        expires_at: new Date(FROZEN_NOW + 60_000),
      });
      await ctx.db.insert(mcpOauthAccessTokens).values({
        tenant_id: otherTenant.id,
        client_id: clientIds[0]!,
        user_id: otherTenantUser.id,
        prefix: "wf_mcp_access_other",
        token_sha256: createHash("sha256").update("legacy-access-other").digest("hex"),
        scope: "mcp:read",
        expires_at: new Date(FROZEN_NOW + 60_000),
      });
      await ctx.db.insert(mcpOauthRefreshTokens).values({
        tenant_id: tenant.id,
        client_id: clientIds[1]!,
        user_id: user.id,
        prefix: "wf_mcr_refresh",
        token_sha256: createHash("sha256").update("legacy-refresh").digest("hex"),
        scope: "mcp:read",
        expires_at: new Date(FROZEN_NOW + 60_000),
      });
      const preservedUnknownSince = new Date(FROZEN_NOW - 60_000);
      await ctx.db.insert(mcpOauthUnknownGrants).values({
        tenant_id: tenant.id,
        client_id: clientIds[0]!,
        unknown_since: preservedUnknownSince,
      });

      expect((await runMigrations(ctx.db, [migration], true)).applied).toBe(1);
      const unknown = await ctx.db
        .select({
          tenant_id: mcpOauthUnknownGrants.tenant_id,
          client_id: mcpOauthUnknownGrants.client_id,
          unknown_since: mcpOauthUnknownGrants.unknown_since,
        })
        .from(mcpOauthUnknownGrants);
      expect(unknown.map((row) => `${row.tenant_id}:${row.client_id}`).sort()).toEqual(
        [
          `${tenant.id}:${clientIds[0]}`,
          `${tenant.id}:${clientIds[1]}`,
          `${otherTenant.id}:${clientIds[0]}`,
        ].sort(),
      );
      const preservedUnknownGrant = unknown.find(
        (row) => row.tenant_id === tenant.id && row.client_id === clientIds[0],
      );
      expect(preservedUnknownGrant?.unknown_since).toEqual(preservedUnknownSince);
      expect((await runMigrations(ctx.db, [migration], true)).applied).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
