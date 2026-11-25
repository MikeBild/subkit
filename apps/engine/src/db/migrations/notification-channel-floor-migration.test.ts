import { expect, test } from "bun:test";
import { runMigrations } from "../migrate.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

test(
  "channel floor migration preserves existing notification thresholds",
  async () => {
    const baseline = EMBEDDED_MIGRATIONS.filter((migration) => migration.idx < 8);
    const ctx = await createTestDb("notification_channel_floor", baseline);
    try {
      const { rows: tenants } = await ctx.pool.query<{ id: string }>(
        "INSERT INTO tenants (slug, display_name) VALUES ('channel-floor', 'Channel floor') RETURNING id",
      );
      const tenant = tenants[0];
      if (!tenant) throw new Error("test tenant was not created");
      const severities = ["debug", "info", "warn", "error", "critical"];
      for (const severity of severities) {
        await ctx.pool.query(
          `INSERT INTO notification_channels
            (tenant_id, workspace_id, channel_id, platform, default_severity)
           VALUES ($1, 'workspace', $2, 'slack', $2)`,
          [tenant.id, severity],
        );
      }
      await ctx.pool.query(
        `INSERT INTO notification_channels (tenant_id, workspace_id, channel_id, platform)
         VALUES ($1, 'workspace', 'legacy-default', 'slack')`,
        [tenant.id],
      );

      expect(await runMigrations(ctx.db)).toMatchObject({ applied: 1 });

      const { rows } = await ctx.pool.query(
        "SELECT channel_id, default_severity FROM notification_channels ORDER BY channel_id",
      );
      expect(rows).toEqual(
        [...severities, "legacy-default"].sort().map((severity) => ({
          channel_id: severity,
          default_severity: severity === "legacy-default" ? "info" : severity,
        })),
      );
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
