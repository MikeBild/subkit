import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { scheduleOccurrences, workflows } from "../../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { cronDueWindow } from "../occurrence-window.ts";
import { type OccurrenceWindowReader, recordScheduleOccurrence } from "../schedule-occurrences.ts";

let ctx: EngineTestCtx;

const ANCHOR = new Date("2026-11-20T21:09:00Z");
const SKIPPED_AT = new Date("2026-11-20T21:10:00Z");
const RAN_AT = new Date("2026-11-20T21:11:00Z");

const windowAt =
  (now: Date): OccurrenceWindowReader =>
  (after) =>
    cronDueWindow("* * * * *", "UTC", after && after > ANCHOR ? after : ANCHOR, now);

const rowsFor = (workflow_id: string) =>
  ctx.testDb.db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.workflow_id, workflow_id))
    .orderBy(desc(scheduleOccurrences.due_at));

const createWorkflow = async (slug: string) => {
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug, name: slug, lifecycle: "active" })
    .returning({ workflow_id: workflows.id });
  return workflow!;
};

beforeAll(async () => {
  ctx = await createEngineCtx("occurrence-merge");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a skipped or held due time is not counted again by the next row", () => {
  test("a run after a skipped date reads ran, not merged_missed", async () => {
    const { workflow_id } = await createWorkflow("skip-then-run");
    const subject = { tenant_id: ctx.tenantId, workflow_id, schedule_id: null };
    await recordScheduleOccurrence(
      ctx.testDb.db,
      subject,
      { state: "skipped", reason_code: "calendar_skip_date" },
      windowAt(SKIPPED_AT),
    );
    await recordScheduleOccurrence(
      ctx.testDb.db,
      subject,
      { state: "ran", reason_code: null, started_at: RAN_AT },
      windowAt(RAN_AT),
    );
    const [ran, skipped] = await rowsFor(workflow_id);
    expect(skipped).toMatchObject({ state: "skipped", due_at: SKIPPED_AT, skipped_count: 1 });
    expect(ran).toMatchObject({
      state: "ran",
      reason_code: null,
      due_at: RAN_AT,
      last_due_at: RAN_AT,
      skipped_count: 0,
    });
  });

  test("a hold after a skipped date starts at the next due time", async () => {
    const { workflow_id } = await createWorkflow("skip-then-hold");
    const subject = { tenant_id: ctx.tenantId, workflow_id, schedule_id: null };
    await recordScheduleOccurrence(
      ctx.testDb.db,
      subject,
      { state: "skipped", reason_code: "calendar_skip_date" },
      windowAt(SKIPPED_AT),
    );
    await recordScheduleOccurrence(
      ctx.testDb.db,
      subject,
      { state: "held", reason_code: "input_required" },
      windowAt(RAN_AT),
    );
    const [held] = await rowsFor(workflow_id);
    expect(held).toMatchObject({ state: "held", due_at: RAN_AT, skipped_count: 1 });
  });
});
