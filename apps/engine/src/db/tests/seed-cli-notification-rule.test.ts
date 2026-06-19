// Idempotency tests for `seedDefaultCliNotificationRule`.
//
// Asserts:
//   1. A freshly bootstrapped tenant has exactly one _cli/_inbox rule.
//   2. Re-running seedDefaultCliNotificationRule on the same tenant is a
//      no-op — the rule count stays at 1.
//   3. The seeded rule has the correct fields (event_pattern="*", severity="info",
//      target_workspace_id="_cli", target_channel_id="_inbox").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { notificationRules, tenants } from "../schema/index.ts";
import { seedDefaultCliNotificationRule } from "../seed.ts";
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
    expect(rule?.event_pattern).toBe("*");
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
