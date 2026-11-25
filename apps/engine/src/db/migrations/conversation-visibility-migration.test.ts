import { expect, test } from "bun:test";
import { runMigrations } from "../migrate.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const TAG = "0009_conversation_visibility";

test(
  "visibility migration makes every conversation private except Slack channel threads",
  async () => {
    const target = EMBEDDED_MIGRATIONS.find((migration) => migration.tag === TAG);
    if (!target) throw new Error(`${TAG} is not embedded`);
    const baseline = EMBEDDED_MIGRATIONS.filter((migration) => migration.idx < target.idx);
    const ctx = await createTestDb("conversation_visibility", baseline);
    try {
      const { rows: tenants } = await ctx.pool.query<{ id: string }>(
        "INSERT INTO tenants (slug, display_name) VALUES ('visibility', 'Visibility') RETURNING id",
      );
      const tenant = tenants[0];
      if (!tenant) throw new Error("test tenant was not created");
      const conversation = async (surface: string | null): Promise<string> => {
        const { rows } = await ctx.pool.query<{ id: string }>(
          "INSERT INTO conversations (tenant_id, status, surface) VALUES ($1, 'active', $2) RETURNING id",
          [tenant.id, surface],
        );
        const id = rows[0]?.id;
        if (!id) throw new Error("conversation was not created");
        return id;
      };
      const workspace = async (platform: string, external: string): Promise<string> => {
        const { rows } = await ctx.pool.query<{ id: string }>(
          `INSERT INTO chat_workspaces (tenant_id, platform, workspace_id, bot_ciphertext, bot_iv, bot_auth_tag)
           VALUES ($1, $2, $3, '\\x00', '\\x00', '\\x00') RETURNING id`,
          [tenant.id, platform, external],
        );
        const id = rows[0]?.id;
        if (!id) throw new Error("workspace was not created");
        return id;
      };
      const session = (workspace_id: string, thread_id: string, conversation_id: string) =>
        ctx.pool.query(
          "INSERT INTO chat_sessions (tenant_id, workspace_id, thread_id, conversation_id) VALUES ($1, $2, $3, $4)",
          [tenant.id, workspace_id, thread_id, conversation_id],
        );

      const cockpit = await conversation("cockpit");
      const slackChannel = await conversation("chat");
      const slackDm = await conversation("chat");
      const slackThread = await conversation("chat");
      const google = await conversation("chat");
      const slack = await workspace("slack", "T1");
      const gchat = await workspace("google_chat", "G1");
      await session(slack, "C0123ABC:root", slackChannel);
      await session(slack, "D0123ABC:root", slackDm);
      await session(slack, "1712345678.000100", slackThread);
      await session(gchat, "spaces/AAA:root", google);

      expect(await runMigrations(ctx.db)).toMatchObject({ applied: 1 });

      const { rows } = await ctx.pool.query<{ id: string; visibility: string }>(
        "SELECT id, visibility FROM conversations",
      );
      const byId = new Map(rows.map((row) => [row.id, row.visibility]));
      expect(byId.get(cockpit)).toBe("private");
      expect(byId.get(slackChannel)).toBe("team");
      expect(byId.get(slackDm)).toBe("private");
      expect(byId.get(slackThread)).toBe("private");
      expect(byId.get(google)).toBe("private");

      const { rows: fresh } = await ctx.pool.query<{ visibility: string }>(
        "INSERT INTO conversations (tenant_id, status) VALUES ($1, 'active') RETURNING visibility",
        [tenant.id],
      );
      expect(fresh[0]?.visibility).toBe("private");
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
