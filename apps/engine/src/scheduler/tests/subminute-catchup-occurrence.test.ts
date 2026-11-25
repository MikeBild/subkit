import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { scheduleOccurrences, workflowsSchedules } from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { fireEverySchedule } from "../workflow-schedule-sweep.ts";
import { createSchedulerCtx, type SchedulerTestCtx } from "./setup.ts";

let ctx: SchedulerTestCtx;

beforeAll(async () => {
  ctx = await createSchedulerCtx("subminute-catchup");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("a sub-minute catch-up run is recorded while a run on time writes no entry", async () => {
  const { db } = ctx.engine.testDb;
  const tenant_id = ctx.engine.tenantId;
  const { workflow_id } = await createWorkflowRow(ctx.engine, {
    name: "Sub-minute catch-up",
    slug: "subminute-catchup",
    steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "input" }],
  });
  const startedAt = Date.now();
  const [schedule] = await db
    .insert(workflowsSchedules)
    .values({
      tenant_id,
      workflow_id,
      cron: "every:15",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: new Date(startedAt - 65_000),
      created_at: new Date(startedAt - 3_600_000),
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  const definition = { schedule_id: schedule.id, tenant_id, workflow_id, seconds: 15 };
  const executionIds = [
    "00000000-0000-4000-8000-000000000624",
    "00000000-0000-4000-8000-000000000625",
  ];
  const fired: string[] = [];
  const fire = async () => {
    const execution_id = executionIds[fired.length] ?? executionIds[0] ?? "";
    fired.push(execution_id);
    return { execution_id };
  };
  const occurrences = () =>
    db
      .select()
      .from(scheduleOccurrences)
      .where(
        and(
          eq(scheduleOccurrences.tenant_id, tenant_id),
          eq(scheduleOccurrences.schedule_id, schedule.id),
        ),
      );

  await fireEverySchedule(db, definition, fire);
  expect(fired).toHaveLength(1);
  const [catchup, ...rest] = await occurrences();
  expect(rest).toHaveLength(0);
  expect(catchup).toMatchObject({
    state: "ran_late",
    reason_code: "merged_missed",
    skipped_count: 3,
    execution_id: executionIds[0],
  });

  await db
    .update(workflowsSchedules)
    .set({ last_enqueued_at: new Date(Date.now() - 16_000) })
    .where(
      and(eq(workflowsSchedules.id, schedule.id), eq(workflowsSchedules.tenant_id, tenant_id)),
    );
  await fireEverySchedule(db, definition, fire);
  expect(fired).toHaveLength(2);
  expect(await occurrences()).toHaveLength(1);
});
