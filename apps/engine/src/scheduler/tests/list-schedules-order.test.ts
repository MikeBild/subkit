import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflows, workflowsSchedules } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { listSchedules } from "../repo.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("list_schedules_order");
  const tenant = await seedTenant(testDb.db, { slug: "t-sched-order", display_name: "SchedOrder" });
  tenant_id = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

test("schedules come back oldest first, and stay in that order after an update", async () => {
  const base = new Date(FROZEN_NOW).getTime();
  for (const [slug, minutesAgo] of [
    ["third", 1],
    ["first", 3],
    ["second", 2],
  ] as const) {
    const [workflow] = await testDb.db
      .insert(workflows)
      .values({ tenant_id, slug, name: slug, lifecycle: "active" })
      .returning();
    if (!workflow) throw new Error("seed workflow failed");
    await testDb.db.insert(workflowsSchedules).values({
      tenant_id,
      workflow_id: workflow.id,
      cron: `${minutesAgo} 3 * * *`,
      created_at: new Date(base - minutesAgo * 60_000),
    });
  }
  const crons = async () => (await listSchedules(testDb.db, tenant_id)).rows.map((row) => row.cron);
  expect(await crons()).toEqual(["3 3 * * *", "2 3 * * *", "1 3 * * *"]);

  await testDb.db
    .update(workflowsSchedules)
    .set({ paused: true })
    .where(eq(workflowsSchedules.cron, "3 3 * * *"));
  expect(await crons()).toEqual(["3 3 * * *", "2 3 * * *", "1 3 * * *"]);
});
