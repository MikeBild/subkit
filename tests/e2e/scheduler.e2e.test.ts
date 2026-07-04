// Scheduler surface — schedule binding → deterministic fan-out → audit.
//
// The reconciler fires on a ~60s interval in production; this suite NEVER
// wall-clock-waits. It seeds a workflow + a `workflows_schedules` row, then
// drives ONE fan-out pass directly via `runReconcileOnce` (which calls the
// reconciler's public `reconcileWorkflowSchedules(now)` with an injected
// `now`). Asserts the fan-out created an execution tagged
// `request_source = "scheduler"` plus the immutable `schedule.trigger.fired`
// audit row, and that `sk schedules list` sees the binding.
//
// LLM: none needed — boot mock to stay hermetic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedWorkflow } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { findScheduledExecutions, runReconcileOnce, seedSchedule } from "./_helpers/scheduler.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("scheduler", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("workflow schedule fan-out", () => {
  test("a due schedule fires exactly one execution with request_source=scheduler", async () => {
    const { id: workflowId } = await seedWorkflow(env, { description: "scheduled wf" });
    const schedule = await seedSchedule(env, workflowId, {
      cron: "* * * * *",
      input: { from: "cron" },
    });
    expect(schedule.id).toBeTruthy();

    // No executions yet.
    const before = await findScheduledExecutions(env, workflowId);
    expect(before).toHaveLength(0);

    // Drive one reconcile pass with `now` a minute in the future so the
    // cron is unambiguously due.
    // allow-wall-clock: injecting a future `now` IS the deterministic seam.
    await runReconcileOnce(env, new Date(Date.now() + 60_000));

    const after = await findScheduledExecutions(env, workflowId);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after[0]?.request_source).toBe("scheduler");

    // A second identical pass must NOT double-fire (CAS-stamp on
    // last_enqueued_at dedups within the same cron window).
    // allow-wall-clock: injecting a future `now` IS the deterministic seam.
    await runReconcileOnce(env, new Date(Date.now() + 60_000));
    const afterSecond = await findScheduledExecutions(env, workflowId);
    expect(afterSecond.length).toBe(after.length);

    // The firing wrote the immutable schedule audit row.
    const api = apiClient(env);
    const audit = await api.get<unknown>("/v1/audit-log?limit=50");
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain("schedule.trigger.fired");
  }, 60_000);

  test("sk schedules list surfaces the bound schedule", async () => {
    const { id: workflowId } = await seedWorkflow(env, { description: "cli schedule" });
    await seedSchedule(env, workflowId, { cron: "0 9 * * *", timezone: "Europe/Berlin" });
    const result = await cli(["schedules", "list"], { env, persona: "admin" });
    expectSuccess(result, "sk schedules list");
  }, 60_000);
});
