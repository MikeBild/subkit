// User story: As a platform operator, I want cron-scheduled workflows
// to fire automatically without an operator pressing "run".
// Acceptance criteria:
//   - AC1: Inserting a `workflows_schedules` row with `every:1` drives
//          the reconciler to schedule a local timer.
//   - AC2: Within five seconds a real execution row with
//          `request_source=scheduler` exists for the workflow.
//   - AC3: That execution reaches a terminal status via the queue
//          handler (worker registered by the journey setup).
// Spec refs: docs/06-scheduler.md, docs/05-execution.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions, workflowsSchedules } from "../../db/schema/index.ts";
import { SchedulerReconciler } from "../../scheduler/reconciler.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { createJourneyCtx, type JourneyCtx, seedWorkflow } from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";
let reconciler: SchedulerReconciler;

beforeAll(async () => {
  ctx = await createJourneyCtx("scheduler");
  const wf = await seedWorkflow(ctx, {
    slug: "cron-probe",
    name: "Cron Probe",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowId = wf.id;

  await ctx.db.insert(workflowsSchedules).values({
    tenant_id: ctx.tenantId,
    workflow_id: workflowId,
    cron: "every:1",
    timezone: "UTC",
    paused: false,
    input: { from: "journey-8" },
  });

  reconciler = new SchedulerReconciler({ boss: ctx.boss, db: ctx.db, intervalMs: 5_000 });
  await reconciler.start();
}, 60_000);

afterAll(async () => {
  await reconciler.stop();
  if (ctx?.cleanup) await ctx.cleanup();
}, 60_000);

describe("journey: scheduler fires cron", () => {
  test("AC1+AC2: every:1 creates an execution within 5s tagged scheduler", async () => {
    const rows = await waitFor(
      async () => {
        const r = await ctx.db
          .select()
          .from(executions)
          .where(eq(executions.workflow_id, workflowId));
        return r.length >= 1 ? r : undefined;
      },
      { tries: 80, sleepMs: 100, label: "scheduler fired" },
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.request_source).toBe("scheduler");
  }, 12_000);

  test("AC3: at least one execution reaches a terminal status", async () => {
    const terminal = await waitFor(
      async () => {
        const rows = await ctx.db
          .select()
          .from(executions)
          .where(eq(executions.workflow_id, workflowId));
        return rows.find((r) => ["succeeded", "failed", "aborted", "timed_out"].includes(r.status));
      },
      { tries: 80, sleepMs: 100, label: "execution terminal" },
    );
    expect(terminal?.status).toBe("succeeded");
  }, 12_000);
});
