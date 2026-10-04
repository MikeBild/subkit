import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { matchGlob } from "../../notifications/matcher.ts";
import { EVENT_CATALOG, type EventCatalogEntry } from "../../webhooks/events/catalog.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { notificationRules, tenants } from "../schema/index.ts";
import { DEFAULT_CLI_INBOX_EVENT_PATTERN, seedDefaultCliNotificationRule } from "../seed.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("seed_cli_notif");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function seedTenant(slug: string): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug, display_name: `Seed CLI Test ${slug}` })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  return t.id;
}

async function cliRulesFor(tenant_id: string) {
  return ctx.db
    .select()
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.tenant_id, tenant_id),
        eq(notificationRules.target_workspace_id, "_cli"),
        eq(notificationRules.target_channel_id, "_inbox"),
      ),
    );
}

describe("seedDefaultCliNotificationRule", () => {
  test("inserts exactly one _cli/_inbox rule for a new tenant", async () => {
    const tenantId = await seedTenant("seed-cli-t1");
    await seedDefaultCliNotificationRule(ctx.db, tenantId);

    const rules = await cliRulesFor(tenantId);
    expect(rules.length).toBe(1);
  });

  test("re-running is idempotent — still exactly one rule", async () => {
    const tenantId = await seedTenant("seed-cli-t2");
    await seedDefaultCliNotificationRule(ctx.db, tenantId);
    await seedDefaultCliNotificationRule(ctx.db, tenantId);
    await seedDefaultCliNotificationRule(ctx.db, tenantId);

    const rules = await cliRulesFor(tenantId);
    expect(rules.length).toBe(1);
  });

  test("seeded rule has correct default fields", async () => {
    const tenantId = await seedTenant("seed-cli-t3");
    await seedDefaultCliNotificationRule(ctx.db, tenantId);

    const rules = await cliRulesFor(tenantId);
    const rule = rules[0];
    expect(rule).toBeDefined();
    expect(rule?.event_pattern).toBe(DEFAULT_CLI_INBOX_EVENT_PATTERN);
    expect(rule?.workflow_pattern).toBe("*");
    expect(rule?.severity).toBe("info");
    expect(rule?.target_workspace_id).toBe("_cli");
    expect(rule?.target_channel_id).toBe("_inbox");
    expect(rule?.active).toBe(true);
  });

  test("rule for one tenant does not appear for a different tenant", async () => {
    const tenantId1 = await seedTenant("seed-cli-t4");
    const tenantId2 = await seedTenant("seed-cli-t5");
    await seedDefaultCliNotificationRule(ctx.db, tenantId1);

    const rulesT2 = await cliRulesFor(tenantId2);
    expect(rulesT2.length).toBe(0);
  });
});

describe("default inbox rule: actionable events only", () => {
  test("the seeded pattern lists exactly the catalog events a person may have to act on", () => {
    const actionable = Object.values(EVENT_CATALOG)
      .filter((entry: EventCatalogEntry) => entry.actionable(entry.example))
      .map((entry) => entry.name)
      .sort();
    expect(DEFAULT_CLI_INBOX_EVENT_PATTERN.split(",").sort()).toEqual(actionable);
    expect(matchGlob(DEFAULT_CLI_INBOX_EVENT_PATTERN, "execution.step.started")).toBe(false);
    expect(matchGlob(DEFAULT_CLI_INBOX_EVENT_PATTERN, "execution.step.finished")).toBe(false);
    expect(matchGlob(DEFAULT_CLI_INBOX_EVENT_PATTERN, "execution.failed")).toBe(true);
  });

  test("the migration narrows only the rule still in its seeded shape", async () => {
    const tenantId = await seedTenant("seed-cli-migrate");
    const seededShape = {
      tenant_id: tenantId,
      name: "sk CLI inbox (default)",
      event_pattern: "*",
      workflow_pattern: "*",
      severity: "info",
      request_source_filter: null,
      target_workspace_id: "_cli",
      target_channel_id: "_inbox",
      active: true,
    };
    const [seeded] = await ctx.db.insert(notificationRules).values(seededShape).returning();
    const [ownInbox] = await ctx.db
      .insert(notificationRules)
      .values({ ...seededShape, name: "all of it, please" })
      .returning();
    const [raisedFloor] = await ctx.db
      .insert(notificationRules)
      .values({ ...seededShape, severity: "warn" })
      .returning();
    const [slack] = await ctx.db
      .insert(notificationRules)
      .values({ ...seededShape, target_workspace_id: "T0123", target_channel_id: "C0456" })
      .returning();
    if (!seeded || !ownInbox || !raisedFloor || !slack) throw new Error("seed rules failed");

    const migration = EMBEDDED_MIGRATIONS.find(
      (m) => m.tag === "0072_default_inbox_rule_actionable",
    );
    if (!migration) throw new Error("migration 0072 is not embedded");
    for (const statement of migration.statements) await ctx.db.execute(sql.raw(statement));

    const after = new Map(
      (
        await ctx.db
          .select({ id: notificationRules.id, event_pattern: notificationRules.event_pattern })
          .from(notificationRules)
          .where(eq(notificationRules.tenant_id, tenantId))
      ).map((r) => [r.id, r.event_pattern]),
    );
    expect(after.get(seeded.id)).toBe(DEFAULT_CLI_INBOX_EVENT_PATTERN);
    expect(after.get(ownInbox.id)).toBe("*");
    expect(after.get(raisedFloor.id)).toBe("*");
    expect(after.get(slack.id)).toBe("*");
  });
});
