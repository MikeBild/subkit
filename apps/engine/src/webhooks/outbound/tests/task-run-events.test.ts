import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import { events } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/logger.ts";
import {
  classifyEvent,
  EVENT_CATALOG,
  emitTaskRunEvent,
  type TaskRunEventType,
  validateEventPayload,
} from "../../events/catalog.ts";
import { WEBHOOK_DELIVER_QUEUE, type WebhookDeliverJob } from "../delivery-worker.ts";
import { extractSeverity, fanoutEventRow } from "../fanout.ts";
import { createOutboundCtx, type OutboundTestCtx } from "./setup.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const TYPES: TaskRunEventType[] = [
  "task_run.started",
  "task_run.waiting",
  "task_run.result_ready",
  "task_run.completed",
  "task_run.failed",
];
const ACTIONABLE: readonly string[] = [
  "task_run.waiting",
  "task_run.result_ready",
  "task_run.failed",
];

let ctx: OutboundTestCtx;

beforeAll(async () => {
  ctx = await createOutboundCtx("task-run-events");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function latestEvent() {
  const [row] = await ctx.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.channel, "notification.emitted")))
    .orderBy(desc(events.id))
    .limit(1);
  if (!row) throw new Error("no event row written");
  return row;
}

describe("task run events", () => {
  test("each event is catalogued with a schema, a valid example and a run pointer", () => {
    for (const type of TYPES) {
      const entry = EVENT_CATALOG[type];
      expect(entry.name as string).toBe(type);
      expect(validateEventPayload(type, entry.example).ok).toBe(true);
      expect(classifyEvent(type, entry.example)).toEqual({
        actionable: ACTIONABLE.includes(type),
        resource_type: "task_run",
        resource_id: "00000000-0000-4000-8000-000000000009",
      });
    }
  });

  test("a payload with an unknown state, a prose failure or a bad id is rejected", () => {
    expect(
      validateEventPayload("task_run.waiting", {
        task_run_id: RUN,
        task_id: TASK,
        trigger: "cron",
        waiting_reason: "the model wants to know the invoice number",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("task_run.failed", {
        task_run_id: RUN,
        task_id: TASK,
        trigger: "cron",
        failure_code: "The provider answered: please try again later",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("task_run.failed", {
        task_run_id: RUN,
        task_id: TASK,
        trigger: "cron",
        failure_code: "Turn_Interrupted",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("task_run.started", {
        task_run_id: "not-a-uuid",
        task_id: TASK,
        trigger: "cron",
        environment: "prod",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("task_run.failed", {
        task_run_id: RUN,
        task_id: TASK,
        trigger: "manual",
        failure_code: null,
      }).ok,
    ).toBe(true);
  });

  test("severities follow the run's state", () => {
    expect(TYPES.map((type) => extractSeverity(type, EVENT_CATALOG[type].example))).toEqual([
      "info",
      "warn",
      "info",
      "info",
      "error",
    ]);
  });

  test("the emitter writes the notification outbox row and keeps only catalogued fields", async () => {
    await emitTaskRunEvent(ctx.db, ctx.tenantId, "task_run.waiting", {
      task_run_id: RUN,
      task_id: TASK,
      trigger: "cron",
      waiting_reason: "approval",
      ...({ goal: "private-goal-canary", question: "private-question-canary" } as object),
    });
    const row = await latestEvent();
    expect(row.type).toBe("task_run.waiting");
    expect(row.payload).toEqual({
      task_run_id: RUN,
      task_id: TASK,
      trigger: "cron",
      waiting_reason: "approval",
    });
  });

  test("a ready result carries the run, the task, the trigger and the turns used", async () => {
    expect(
      await emitTaskRunEvent(ctx.db, ctx.tenantId, "task_run.result_ready", {
        task_run_id: RUN,
        task_id: TASK,
        trigger: "cron",
        turns_used: 4,
      }),
    ).toBe(true);
    const row = await latestEvent();
    expect(row.type).toBe("task_run.result_ready");
    expect(row.payload).toEqual({
      task_run_id: RUN,
      task_id: TASK,
      trigger: "cron",
      turns_used: 4,
    });
  });

  test("a failure code that is not a code is emitted as null, never as text", async () => {
    for (const failure_code of ["The provider said: try later", "Turn_Interrupted", ""]) {
      expect(
        await emitTaskRunEvent(ctx.db, ctx.tenantId, "task_run.failed", {
          task_run_id: RUN,
          task_id: TASK,
          trigger: "manual",
          failure_code,
        }),
      ).toBe(true);
      expect((await latestEvent()).payload).toEqual({
        task_run_id: RUN,
        task_id: TASK,
        trigger: "manual",
        failure_code: null,
      });
    }
  });

  test("any other invalid payload is skipped with a warning and never throws into the caller's transaction", async () => {
    const before = await latestEvent();
    const warn = spyOn(logger, "warn");
    try {
      const emitted = await ctx.db.transaction(async (tx) => {
        const result = await emitTaskRunEvent(tx, ctx.tenantId, "task_run.completed", {
          task_run_id: RUN,
          task_id: TASK,
          trigger: "manual",
          turns_used: 3,
          duration_ms: -1,
        });
        await tx.execute(sql`select 1`);
        return result;
      });
      expect(emitted).toBe(false);
      const warned = warn.mock.calls.map((call) => call[0] as Record<string, unknown>);
      const entry = warned.find((item) => item.action === "task_run_event.skipped");
      expect(entry).toMatchObject({ event_type: "task_run.completed", tenant_id: ctx.tenantId });
      expect(JSON.stringify(entry)).not.toContain(RUN);
    } finally {
      warn.mockRestore();
    }
    expect((await latestEvent()).id).toBe(before.id);
  });

  test("an emitted event reaches a subscription on task_run.*", async () => {
    const sub = await ctx.createSub({
      event_pattern: "task_run.*",
      target_url: "http://127.0.0.1:0/ignored",
      secret: "whsec_taskrunaaaaaaaaaaaaaaaaaaa",
    });
    await emitTaskRunEvent(ctx.db, ctx.tenantId, "task_run.failed", {
      task_run_id: RUN,
      task_id: TASK,
      trigger: "once",
      failure_code: "turn_interrupted",
    });
    const row = await latestEvent();
    const stats = await fanoutEventRow(ctx.db, ctx.boss, row.id);
    expect(stats?.matched).toBe(1);
    expect(stats?.enqueued).toBe(1);
    const jobs = await ctx.boss.fetch<WebhookDeliverJob>(WEBHOOK_DELIVER_QUEUE, { batchSize: 5 });
    expect(jobs?.length).toBe(1);
    const job = jobs?.[0];
    expect(job?.data.subscription_id).toBe(sub.id);
    expect(job?.data.event_type).toBe("task_run.failed");
    expect(JSON.parse(job?.data.body ?? "{}").data).toEqual({
      task_run_id: RUN,
      task_id: TASK,
      trigger: "once",
      failure_code: "turn_interrupted",
    });
    if (job) await ctx.boss.complete(WEBHOOK_DELIVER_QUEUE, job.id);
  });
});
