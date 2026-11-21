import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflows, workflowsSchedules } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { bindFromWorkflow, createSchedule, updateSchedule } from "../repo.ts";

let testDb: TestDb;
let tenant_id: string;

const MIKE = "0a0a0a0a-0000-4000-8000-000000000001";
const ANNA = "0a0a0a0a-0000-4000-8000-000000000002";

async function workflow(slug: string): Promise<string> {
  const [row] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  return (row as { id: string }).id;
}

async function creatorOf(id: string): Promise<string | null> {
  const [row] = await testDb.db
    .select({ created_by: workflowsSchedules.created_by })
    .from(workflowsSchedules)
    .where(eq(workflowsSchedules.id, id));
  return row?.created_by ?? null;
}

beforeAll(async () => {
  testDb = await createTestDb("schedule_created_by");
  tenant_id = (await seedTenant(testDb.db, { slug: "t-sched-creator", display_name: "Creator" }))
    .id;
});

afterAll(async () => {
  await testDb.cleanup();
});

test("a schedule remembers the person who last set it up", async () => {
  const workflow_id = await workflow("creator-api");
  const created = await createSchedule(testDb.db, {
    tenant_id,
    workflow_id,
    cron: "0 7 * * *",
    creator: { kind: "user", id: MIKE, tenant_id },
  });
  expect(await creatorOf(created.row.id)).toBe(MIKE);
  await updateSchedule(testDb.db, tenant_id, created.row.id, { paused: true });
  expect(await creatorOf(created.row.id)).toBe(MIKE);
  await updateSchedule(testDb.db, tenant_id, created.row.id, {
    cron: "0 8 * * *",
    created_by: ANNA,
  });
  expect(await creatorOf(created.row.id)).toBe(ANNA);
  const byKey = await createSchedule(testDb.db, {
    tenant_id,
    workflow_id,
    cron: "0 9 * * *",
    creator: null,
  });
  expect(await creatorOf(byKey.row.id)).toBeNull();
});

test("a schedule trigger saved with the workflow belongs to the person who saved it", async () => {
  const workflow_id = await workflow("creator-trigger");
  const trigger = { kind: "schedule" as const, cron: "0 7 * * *", tz: "Europe/Berlin" };
  const bound = await bindFromWorkflow(testDb.db, {
    tenant_id,
    workflow_id,
    trigger,
    actor_id: MIKE,
    actor_type: "user",
  });
  expect(await creatorOf(bound.row.id)).toBe(MIKE);
  const rebound = await bindFromWorkflow(testDb.db, {
    tenant_id,
    workflow_id,
    trigger: { ...trigger, cron: "0 8 * * *" },
    actor_id: null,
    actor_type: "system",
  });
  expect(await creatorOf(rebound.row.id)).toBeNull();
});
