import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { scheduleOccurrences, tasks, workflows } from "../../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { cronDueWindow, onceDueWindow } from "../occurrence-window.ts";
import { type OccurrenceWindowReader, recordScheduleOccurrence } from "../schedule-occurrences.ts";

let ctx: EngineTestCtx;
const uuid = createDeterministicUuidFactory(548);

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

  test.each([
    { state: "held" as const, reason_code: "execution_authority_unavailable" },
    { state: "skipped" as const, reason_code: "failure_backoff" },
  ])("a one-shot hold changing to $state with $reason_code starts a new row", async (entry) => {
    const [task] = await ctx.testDb.db
      .insert(tasks)
      .values({
        locale: "en",
        tenant_id: ctx.tenantId,
        name: `once-held-then-${entry.reason_code}`,
        owner_id: uuid(),
        goal: "goal",
        done_when: "done",
        plan: {},
        bindings: {
          workflow_ids: [],
          connector_ids: [],
          skill_slugs: [],
          web_search: false,
        },
        environment: "dev",
        schedule_run_at: SKIPPED_AT,
        fingerprint: "a".repeat(64),
        description_source: "human",
        category_source: "human",
      })
      .returning({ task_id: tasks.id });
    const subject = { tenant_id: ctx.tenantId, task_id: task!.task_id };
    const onceAt: OccurrenceWindowReader = (after) => onceDueWindow(SKIPPED_AT, after, RAN_AT);
    await recordScheduleOccurrence(
      ctx.testDb.db,
      subject,
      { state: "held", reason_code: "input_required" },
      onceAt,
    );
    await recordScheduleOccurrence(ctx.testDb.db, subject, entry, onceAt);
    await recordScheduleOccurrence(ctx.testDb.db, subject, entry, onceAt);
    const rows = await ctx.testDb.db
      .select()
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.task_id, task!.task_id));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "held", reason_code: "input_required" }),
        expect.objectContaining({
          ...entry,
          due_at: SKIPPED_AT,
          last_due_at: SKIPPED_AT,
          skipped_count: 1,
        }),
      ]),
    );
  });

  test("a one-shot task released from a hold keeps its due time and reads late", async () => {
    const [task] = await ctx.testDb.db
      .insert(tasks)
      .values({
        locale: "en",
        tenant_id: ctx.tenantId,
        name: "once-held-then-run",
        owner_id: uuid(),
        goal: "goal",
        done_when: "done",
        plan: {},
        bindings: {
          workflow_ids: [],
          connector_ids: [],
          skill_slugs: [],
          web_search: false,
        },
        environment: "dev",
        schedule_run_at: SKIPPED_AT,
        fingerprint: "a".repeat(64),
        description_source: "human",
        category_source: "human",
      })
      .returning({ task_id: tasks.id });
    const subject = { tenant_id: ctx.tenantId, task_id: task!.task_id };
    const onceAt =
      (now: Date): OccurrenceWindowReader =>
      (after) =>
        onceDueWindow(SKIPPED_AT, after, now);
    await recordScheduleOccurrence(
      ctx.testDb.db,
      subject,
      { state: "held", reason_code: "input_required" },
      onceAt(SKIPPED_AT),
    );
    const releasedAt = new Date(SKIPPED_AT.getTime() + 10 * 60_000);
    await recordScheduleOccurrence(
      ctx.testDb.db,
      subject,
      { state: "ran", reason_code: null, started_at: releasedAt },
      onceAt(releasedAt),
    );
    const [ran, held] = await ctx.testDb.db
      .select()
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.task_id, task!.task_id))
      .orderBy(desc(scheduleOccurrences.created_at));
    expect(held).toMatchObject({ state: "held", due_at: SKIPPED_AT });
    expect(ran).toMatchObject({
      state: "ran_late",
      reason_code: "late_start",
      due_at: SKIPPED_AT,
      last_due_at: SKIPPED_AT,
      started_at: releasedAt,
      skipped_count: 0,
    });
  });
});
