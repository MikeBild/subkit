// createSchedule is update-or-insert on (tenant_id, workflow_id): a workflow
// carries at most one schedule row. The reconciler fires each row
// independently, so an unguarded insert let repeated create_schedule calls
// (each landing on a different minute) accumulate rows that each fired — one
// logical schedule became N real runs. These tests lock the single-row
// invariant and the unique index that backs it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { tenants, workflows, workflowsSchedules } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createSchedule, listSchedules } from "../repo.ts";

let testDb: TestDb;
let tenant_id: string;
let workflow_id: string;

beforeAll(async () => {
  testDb = await createTestDb("create_schedule_dedup");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-sched-dedup", display_name: "SchedDedup" })
    .returning();
  tenant_id = t!.id;
  const [wf] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug: "errorlog", name: "Errorlog", lifecycle: "active" })
    .returning();
  workflow_id = wf!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

test("repeated create_schedule for one workflow keeps a single, updated row", async () => {
  const first = await createSchedule(testDb.db, {
    tenant_id,
    workflow_id,
    cron: "1 3 * * *",
    input: { note: "first" },
  });
  // Same workflow, different minute + input — the pattern that produced 16
  // duplicate rows in prod. It must UPDATE the existing row, not append.
  const second = await createSchedule(testDb.db, {
    tenant_id,
    workflow_id,
    cron: "15 3 * * *",
    input: { note: "second" },
  });

  expect(second.id).toBe(first.id);
  expect(second.cron).toBe("15 3 * * *");
  expect((second.input as { note?: string }).note).toBe("second");

  const rows = await listSchedules(testDb.db, tenant_id, workflow_id);
  expect(rows.total).toBe(1);
  expect(rows.rows[0]?.cron).toBe("15 3 * * *");
});

test("the unique index forbids a second row for the same workflow", async () => {
  // Direct insert bypassing createSchedule — the DB itself must reject it.
  let threw = false;
  try {
    await testDb.db.insert(workflowsSchedules).values({
      tenant_id,
      workflow_id,
      cron: "20 3 * * *",
      timezone: "UTC",
      paused: false,
      input: null,
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  const remaining = await testDb.db
    .select()
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
      ),
    );
  expect(remaining.length).toBe(1);
});
