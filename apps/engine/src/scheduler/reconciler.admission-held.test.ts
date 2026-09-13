import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { executions, workflowsSchedules } from "../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../execution/tests/setup.ts";
import { logger } from "../logging/logger.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { logScheduleFireFailure } from "./schedule-fire-failure.ts";
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";

let ctx: EngineTestCtx;
beforeAll(async () => {
  ctx = await createEngineCtx("schedule-admission-held");
});
afterAll(async () => {
  await ctx.cleanup();
});

test("missing authority stays held and retryable; later approval admits exactly one run", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Held schedule",
    slug: "held-schedule",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date("2026-05-01T00:00:00Z"),
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  const sent: unknown[] = [];
  const boss = {
    send: async (_queue: string, payload: unknown) => {
      sent.push(payload);
      return "job";
    },
  } as unknown as PgBoss;
  const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  const now = new Date("2026-06-05T12:00:00Z");
  const scheduleWhere = and(
    eq(workflowsSchedules.id, schedule.id),
    eq(workflowsSchedules.tenant_id, ctx.tenantId),
  );
  try {
    await reconciler.reconcileWorkflowSchedules(now);
    await reconciler.reconcileWorkflowSchedules(now);
    expect(sent).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      action: "schedule.admission_held",
      tenant_id: ctx.tenantId,
      workflow_id,
      schedule_id: schedule.id,
      reason_code: "execution_authority_unavailable",
    });
    expect(
      (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0]
        ?.last_enqueued_at,
    ).toBeNull();
    expect(
      await ctx.testDb.db
        .select()
        .from(executions)
        .where(
          and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow_id)),
        ),
    ).toHaveLength(0);
    await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);
    await reconciler.reconcileWorkflowSchedules(now);
    await reconciler.reconcileWorkflowSchedules(now);
    expect(sent).toHaveLength(1);
    expect(
      (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0]
        ?.last_enqueued_at,
    ).toEqual(now);
    expect(error).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("dynamic effects require concrete review and stay out of the execution queue", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Dynamic schedule",
    slug: "dynamic-held-schedule",
    steps: [{ id: "send", kind: "request", method: "POST", url: "$input.url" }],
  });
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date("2026-05-01T00:00:00Z"),
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  const sent: unknown[] = [];
  const boss = {
    send: async (_queue: string, payload: unknown) => {
      sent.push(payload);
      return "job";
    },
  } as unknown as PgBoss;
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    await new SchedulerReconciler({ boss, db: ctx.testDb.db }).reconcileWorkflowSchedules(
      new Date("2026-06-05T12:00:00Z"),
    );
    expect(sent).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      action: "schedule.admission_held",
      reason_code: "execution_authority_required",
      schedule_id: schedule.id,
    });
    expect(
      (
        await ctx.testDb.db
          .select()
          .from(workflowsSchedules)
          .where(
            and(
              eq(workflowsSchedules.id, schedule.id),
              eq(workflowsSchedules.tenant_id, ctx.tenantId),
            ),
          )
      )[0]?.last_enqueued_at,
    ).toBeNull();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("technical failures and lookalike messages remain errors", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    for (const failure of [
      new Error("queue unavailable"),
      new Error("this workflow requires concrete-run review for its current effects"),
      Object.assign(new Error("invalid input"), { code: "input_schema_violation" }),
    ]) {
      logScheduleFireFailure(
        failure,
        { tenant_id: ctx.tenantId, workflow_id: "workflow", schedule_id: "schedule" },
        "schedule.fanout_failed",
      );
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(3);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});
