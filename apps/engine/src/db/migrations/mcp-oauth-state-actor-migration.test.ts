import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { runMigrations } from "../migrate.ts";
import { connectors, tenants } from "../schema/index.ts";
import { mcpOauthStates } from "../schema/mcp_oauth_states.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find((item) => item.tag === "0106_chubby_wolf_cub");

test(
  "keeps historical MCP OAuth actors unknown and stores typed actors on new states",
  async () => {
    if (!migration) throw new Error("MCP OAuth state actor migration is not embedded");
    const ctx = await createTestDb("mcp_oauth_state_actor_migration", {
      upToIdx: migration.idx - 1,
    });
    try {
      const [tenant] = await ctx.db
        .insert(tenants)
        .values({ slug: "mcp-oauth-state-actor-migration", display_name: "MCP OAuth state actor" })
        .returning({ id: tenants.id });
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

      expect((await runMigrations(ctx.db, [migration], true)).applied).toBe(1);
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
      expect((await runMigrations(ctx.db, [migration], true)).applied).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
