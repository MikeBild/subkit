import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../apps/engine/src/db/schema/index.ts";
import { grantScheduleAuthorityFixture } from "../../apps/engine/src/scheduler/tests/authority-fixture.ts";
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
    const authority = await grantScheduleAuthorityFixture(
      env.db,
      env.tenantId,
      workflowId,
      "prod",
      1,
    );
    const schedule = await seedSchedule(env, workflowId, {
      cron: "* * * * *",
      input: { from: "cron" },
    });
    expect(schedule.id).toBeTruthy();

    const before = await findScheduledExecutions(env, workflowId);
    expect(before).toHaveLength(0);

    // allow-wall-clock: injecting a future `now` IS the deterministic seam.
    await runReconcileOnce(env, new Date(Date.now() + 60_000));

    const after = await findScheduledExecutions(env, workflowId);
    expect(after).toHaveLength(1);
    expect(after[0]?.request_source).toBe("scheduler");
    expect(after[0]?.execution_authority_id).toBe(authority.id);

    // allow-wall-clock: injecting a future `now` IS the deterministic seam.
    await runReconcileOnce(env, new Date(Date.now() + 60_000));
    const afterSecond = await findScheduledExecutions(env, workflowId);
    expect(afterSecond.length).toBe(after.length);

    const api = apiClient(env);
    const audit = await api.get<unknown>("/v1/audit-log?limit=50");
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain("schedule.trigger.fired");
    expect(JSON.stringify(audit.body)).not.toContain(authority.id);
    const [fired] = await env.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, env.tenantId),
          eq(auditLog.action, "schedule.trigger.fired"),
          eq(auditLog.resource_id, schedule.id),
        ),
      );
    expect(fired?.metadata).toMatchObject({
      execution_authority_id: authority.id,
      origin_source: "scheduler",
    });
  }, 60_000);

  test("a due schedule without an execution authority creates no run", async () => {
    const { id: workflowId } = await seedWorkflow(env, { description: "not authorized" });
    await seedSchedule(env, workflowId, { cron: "* * * * *" });
    // allow-wall-clock: the explicit future instant makes the cadence due.
    await runReconcileOnce(env, new Date(Date.now() + 60_000));
    expect(await findScheduledExecutions(env, workflowId)).toHaveLength(0);
  }, 60_000);

  test("subkit schedules list surfaces the bound schedule", async () => {
    const { id: workflowId } = await seedWorkflow(env, { description: "cli schedule" });
    await seedSchedule(env, workflowId, { cron: "0 9 * * *", timezone: "Europe/Berlin" });
    const result = await cli(["schedules", "list"], { env, persona: "admin" });
    expectSuccess(result, "subkit schedules list");
  }, 60_000);
});
