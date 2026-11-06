import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { connectors } from "../schema/index.ts";
import { mcpOauthStates } from "../schema/mcp_oauth_states.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";

test(
  "an MCP OAuth state without actor stays unattributed and a typed actor is stored",
  async () => {
    const ctx = await createTestDb("mcp_oauth_state_actor_migration");
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"mcp-oauth-state-actor-migration"}, ${"MCP OAuth state actor"}) RETURNING id
  `);
      if (!tenant) throw new Error("test tenant was not created");
      const [connector] = await ctx.db
        .insert(connectors)
        .values({
          tenant_id: tenant.id,
          slug: "mcp-oauth-state-actor-migration",
          display_name: "MCP OAuth state actor",
          driver: "mcp",
        })
        .returning({ id: connectors.id });
      if (!connector) throw new Error("test connector was not created");

      const { rows: legacyRows } = await ctx.pool.query(
        `INSERT INTO mcp_oauth_states
          (tenant_id, connector_id, state, redirect_uri, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '5 minutes')
         RETURNING id`,
        [tenant.id, connector.id, "legacy-state", "https://engine.test/callback"],
      );
      const legacy = legacyRows[0] as { id: string } | undefined;
      if (!legacy) throw new Error("legacy OAuth state was not created");

      const [historical] = await ctx.db
        .select({
          started_by_actor_id: mcpOauthStates.started_by_actor_id,
          started_by_actor_type: mcpOauthStates.started_by_actor_type,
        })
        .from(mcpOauthStates)
        .where(eq(mcpOauthStates.id, legacy.id));
      expect(historical).toEqual({ started_by_actor_id: null, started_by_actor_type: null });

      await ctx.db.insert(mcpOauthStates).values({
        tenant_id: tenant.id,
        connector_id: connector.id,
        state: "typed-state",
        redirect_uri: "https://engine.test/callback",
        expires_at: new Date(FROZEN_NOW + 300_000),
        started_by_actor_type: "system_account",
      });
      const [typed] = await ctx.db
        .select({ started_by_actor_type: mcpOauthStates.started_by_actor_type })
        .from(mcpOauthStates)
        .where(eq(mcpOauthStates.state, "typed-state"));
      expect(typed).toEqual({ started_by_actor_type: "system_account" });
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
