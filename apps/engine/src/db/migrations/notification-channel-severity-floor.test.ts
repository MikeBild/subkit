import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { dispatchEvent } from "../../notifications/service.ts";
import { FakeAdapter } from "../../notifications/tests/setup.ts";
import { runMigrations } from "../migrate.ts";
import { tenants } from "../schema/index.ts";
import { notificationChannels, notificationRules } from "../schema/notifications.ts";
import { createTestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

test("legacy channel floors remain effective after a rule severity is lowered", async () => {
  const ctx = await createTestDb(
    "legacy_channel_floor",
    EMBEDDED_MIGRATIONS.filter((migration) => migration.tag !== "0008_notification_channel_floor"),
  );
  try {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "legacy-channel-floor", display_name: "Legacy channel floor" })
      .returning();
    if (!tenant) throw new Error("test tenant was not created");
    const [channel] = await ctx.db
      .insert(notificationChannels)
      .values({
        tenant_id: tenant.id,
        workspace_id: "W_LEGACY",
        channel_id: "C_LEGACY",
        platform: "slack",
        default_severity: "error",
      })
      .returning();
    const [rule] = await ctx.db
      .insert(notificationRules)
      .values({
        tenant_id: tenant.id,
        name: "legacy-errors",
        event_pattern: "execution.*",
        severity: "error",
        target_workspace_id: "W_LEGACY",
        target_channel_id: "C_LEGACY",
      })
      .returning();
    if (!channel || !rule) throw new Error("test notification rows were not created");

    await runMigrations(ctx.db);
    await ctx.db
      .update(notificationRules)
      .set({ severity: "warn" })
      .where(eq(notificationRules.id, rule.id));
    const adapter = new FakeAdapter();
    const event = { tenant_id: tenant.id, type: "execution.failed", severity: "warn" as const };
    const result = await dispatchEvent({ db: ctx.db, resolveAdapter: () => adapter }, event);
    expect(result.matched).toBe(1);
    expect(result.delivered).toBe(0);
    expect(result.outcomes[0]?.reason).toBe("below_channel_severity");
    expect(adapter.sends).toHaveLength(0);

    await ctx.db
      .update(notificationChannels)
      .set({ default_severity: "debug" })
      .where(eq(notificationChannels.id, channel.id));
    const delivered = await dispatchEvent({ db: ctx.db, resolveAdapter: () => adapter }, event);
    expect(delivered.delivered).toBe(1);
    expect(adapter.sends).toHaveLength(1);

    await ctx.db
      .update(notificationChannels)
      .set({ default_severity: "error" })
      .where(eq(notificationChannels.id, channel.id));
    await runMigrations(ctx.db);
    const filtered = await dispatchEvent({ db: ctx.db, resolveAdapter: () => adapter }, event);
    expect(filtered.outcomes[0]?.reason).toBe("below_channel_severity");
    expect(adapter.sends).toHaveLength(1);
  } finally {
    await ctx.cleanup();
  }
});
