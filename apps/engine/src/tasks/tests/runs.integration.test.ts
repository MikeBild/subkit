import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { PlaybookPlanSchema } from "../../conversations/public/authoring.ts";
import { taskGrants, users } from "../../db/schema/index.ts";
import {
  authorizationContextFromPrincipal,
  rehydrateExecutionPrincipal,
} from "../../execution/authorization-context.ts";
import { callerFromPrincipal } from "../../execution/caller-context.ts";
import { BadRequestError, ConflictError } from "../../http/errors.ts";
import { createSkill } from "../../skills/service.ts";
import {
  completeTaskRun,
  countTaskRuns,
  getTaskRunByConversation,
  listTaskRuns,
  loadTaskOwner,
  pauseTask,
  recordRunObservation,
  type StartTaskRunParams,
  SYSTEM_SCOPE,
  startTaskRun,
  TASK_RESULT_STEP_ID,
  type TaskServiceDeps,
  taskRunPrincipal,
} from "../index.ts";
import {
  auditRows,
  changeEvents,
  conversationRow,
  ctx,
  facts,
  grantFor,
  grantRow,
  NOW,
  nextTurn,
  observed,
  ownedTask,
  recordingDeps,
  started,
  taskInput,
  useTaskDb,
  workspace,
} from "./fixtures.ts";

useTaskDb("tasks_runs");

const SKILL = "weekly-report-notes";

describe("tasks/service starting runs", () => {
  test("a manual start creates a marked conversation with a fresh plan instance", async () => {
    const w = await workspace();
    await createSkill(
      {
        tenant_id: w.tenant_id,
        slug: SKILL,
        input: { scope: "global", title: "Report notes", body: "Use the weekly numbers." },
      },
      ctx.db,
    );
    const task = await ownedTask(
      w,
      taskInput({
        bindings: {
          workflow_ids: [],
          connector_ids: [],
          skill_slugs: [SKILL, "does-not-exist"],
          web_search: true,
        },
      }),
    );
    const { deps, seen } = recordingDeps();
    const run = await started(w, task, deps);
    expect(run).toMatchObject({
      task_id: task.id,
      task_revision: 1,
      fingerprint: task.fingerprint,
      trigger: "manual",
      started_by: w.owner.id,
      grant_id: null,
      state: "running",
      turns_used: 0,
      deadline_at: new Date(NOW.getTime() + 240 * 60_000).toISOString(),
    });
    expect(run.trace_id).toMatch(/^[0-9a-f]{32}$/);
    const conversation = await conversationRow(w.tenant_id, run.conversation_id ?? "");
    expect(conversation).toMatchObject({
      owner_id: w.owner.id,
      title: "Weekly report",
      title_locked: true,
      surface: "web",
      playbook_revision: 1,
    });
    expect((conversation.draft as { session?: Record<string, unknown> }).session).toMatchObject({
      task_run: {
        task_id: task.id,
        task_run_id: run.id,
        environment: "dev",
        workflow_ids: [],
        connector_ids: [],
        web_search: true,
      },
    });
    const plan = PlaybookPlanSchema.parse((conversation.playbook as { plan: unknown }).plan);
    expect(plan.goal).toBe(task.goal);
    expect(plan.completion_step_id).toBe(TASK_RESULT_STEP_ID);
    expect(plan.steps.map((step) => step.id)).toEqual(["collect", TASK_RESULT_STEP_ID]);
    expect(plan.steps.at(-1)?.criterion).toEqual({
      kind: "human_confirmation",
      question: task.goal,
    });
    expect(plan.steps.flatMap((step) => step.evidence_ids)).toEqual([]);
    const slugs = conversation.loaded_skills.map((entry) => entry.slug);
    expect(slugs).toContain(SKILL);
    expect(slugs).not.toContain("does-not-exist");
    const audit = await auditRows(w.tenant_id, run.id);
    expect(audit.map((entry) => [entry.action, entry.actor_type, entry.actor_id])).toEqual([
      ["task_run.started", "user", w.owner.id],
    ]);
    expect(audit[0]?.trace_id).toBe(run.trace_id);
    expect(audit[0]?.metadata).toMatchObject({
      task_id: task.id,
      task_run_id: run.id,
      trigger: "manual",
      task_revision: 1,
      task_grant_id: null,
      environment: "dev",
      deadline_at: run.deadline_at,
    });
    expect(seen.payloads).toEqual([
      { task_run_id: run.id, task_id: task.id, trigger: "manual", environment: "dev" },
    ]);
    expect(seen).toMatchObject({ admissions: [], outcomes: ["started"] });
    expect((await changeEvents(w.tenant_id, "task_run.changed")).at(-1)).toEqual({
      payload: { task_id: task.id, task_run_id: run.id },
    });
    expect(
      (
        await getTaskRunByConversation(
          { tenant_id: w.tenant_id, principal: w.owner, conversation_id: conversation.id },
          ctx.db,
        )
      )?.id,
    ).toBe(run.id);
  });

  test("a person starts manual runs and nobody starts scheduled ones", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const attempts: Array<Pick<StartTaskRunParams, "trigger" | "started_by">> = [
      { trigger: "manual" as const, started_by: SYSTEM_SCOPE },
      { trigger: "cron" as const, started_by: w.owner },
      { trigger: "once" as const, started_by: w.admin },
    ];
    for (const attempt of attempts) {
      const refused = await startTaskRun(
        { tenant_id: w.tenant_id, task_id: task.id, ...attempt },
        ctx.db,
        deps,
      ).catch((e) => e);
      expect(refused).toBeInstanceOf(BadRequestError);
      expect(refused.details).toEqual({ code: "task_run_starter_invalid" });
    }
    expect(
      await countTaskRuns(
        { tenant_id: w.tenant_id, principal: SYSTEM_SCOPE, task_id: task.id },
        ctx.db,
      ),
    ).toBe(0);
  });

  test("a second start is refused while a run is open, but not after a result is ready", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps, seen } = recordingDeps();
    const first = await started(w, task, deps);
    const start = () =>
      startTaskRun(
        { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.owner },
        ctx.db,
        deps,
      );
    expect(await start()).toEqual({ admitted: false, reason: "previous_run_active" });
    const ready = await recordRunObservation(
      {
        tenant_id: w.tenant_id,
        task_run_id: first.id,
        observation: observed({
          turn_id: nextTurn(),
          playbook: facts({ awaiting_result_confirmation: true }),
        }),
        source: "queue",
      },
      ctx.db,
      deps,
    );
    expect(ready).toMatchObject({ changed: true, enqueue: false });
    expect(ready.run).toMatchObject({
      state: "result_ready",
      result_ready_at: NOW.toISOString(),
      ended_at: NOW.toISOString(),
      turns_used: 1,
      last_playbook_revision: 2,
    });
    const second = await start();
    expect(second.admitted).toBe(true);
    expect(seen.admissions).toEqual(["previous_run_active"]);
    const scope = { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id };
    expect((await listTaskRuns(scope, ctx.db)).map((run) => run.state).sort()).toEqual([
      "result_ready",
      "running",
    ]);
    expect(await countTaskRuns(scope, ctx.db)).toBe(2);
    expect(await countTaskRuns({ ...scope, principal: w.member }, ctx.db)).toBe(0);
    const confirm = { tenant_id: w.tenant_id, principal: w.owner, task_run_id: first.id };
    const done = await completeTaskRun(confirm, ctx.db, deps);
    expect(done).toMatchObject({
      state: "completed",
      completed_by: w.owner.id,
      completed_at: NOW.toISOString(),
    });
    await completeTaskRun(confirm, ctx.db, deps);
    expect(
      (await auditRows(w.tenant_id, first.id)).map((entry) => [entry.action, entry.actor_type]),
    ).toEqual([
      ["task_run.started", "user"],
      ["task_run.result_ready", "system"],
      ["task_run.completed", "user"],
    ]);
    expect(seen.webhooks).toEqual([
      "task_run.started",
      "task_run.result_ready",
      "task_run.started",
      "task_run.completed",
    ]);
    expect(seen.payloads[1]).toEqual({
      task_run_id: first.id,
      task_id: task.id,
      trigger: "manual",
      turns_used: 1,
    });
    expect(seen.outcomes).toEqual(["started", "started", "completed"]);
    const open = second.admitted ? second.run.id : "";
    const early = await completeTaskRun({ ...confirm, task_run_id: open }, ctx.db, deps).catch(
      (e) => e,
    );
    expect(early).toBeInstanceOf(ConflictError);
  });

  test("the last run of a grant keeps its permission until it ends", async () => {
    const w = await workspace();
    const task = await ownedTask(w, taskInput({ schedule_cron: "0 8 * * 1" }));
    const { deps, seen } = recordingDeps();
    const start = () =>
      startTaskRun(
        {
          tenant_id: w.tenant_id,
          task_id: task.id,
          trigger: "cron",
          started_by: SYSTEM_SCOPE,
          source: "scheduler",
        },
        ctx.db,
        deps,
      );
    expect(await start()).toEqual({ admitted: false, reason: "grant_required" });
    const stale = await grantFor(w, task, { fingerprint: "f".repeat(64) });
    expect(await start()).toEqual({ admitted: false, reason: "grant_fingerprint_mismatch" });
    await ctx.db
      .update(taskGrants)
      .set({ revoked_at: NOW, revoked_by: w.owner.id })
      .where(and(eq(taskGrants.tenant_id, w.tenant_id), eq(taskGrants.id, stale)));
    const grantId = await grantFor(w, task, { max_runs: 1 });
    const result = await start();
    if (!result.admitted) throw new Error(result.reason);
    const run = result.run;
    expect(run).toMatchObject({ trigger: "cron", started_by: null, grant_id: grantId });
    expect(await grantRow(w.tenant_id, grantId)).toMatchObject({
      reserved_runs: 1,
      revoked_at: null,
    });
    expect(seen.revocations).toEqual([]);
    const audit = await auditRows(w.tenant_id, run.id);
    expect(audit[0]).toMatchObject({
      action: "task_run.started",
      actor_type: "system",
      actor_id: null,
    });
    expect(audit[0]?.metadata).toMatchObject({
      task_grant_id: grantId,
      request_source: "scheduler",
    });
    const owner = await loadTaskOwner(ctx.db, w.tenant_id, w.owner.id);
    const principal = taskRunPrincipal(
      { tenant_id: w.tenant_id, owner_id: task.owner_id, id: task.id, bindings: task.bindings },
      owner,
      { id: run.id, grant_id: run.grant_id },
    );
    const rehydrate = () =>
      rehydrateExecutionPrincipal(
        ctx.db,
        callerFromPrincipal(principal, w.tenant_id, undefined, "user"),
        authorizationContextFromPrincipal(principal),
      );
    expect((await rehydrate())?.id).toBe(w.owner.id);
    expect(await start()).toEqual({ admitted: false, reason: "previous_run_active" });
    const failed = await recordRunObservation(
      {
        tenant_id: w.tenant_id,
        task_run_id: run.id,
        observation: observed({
          turn_id: nextTurn(),
          turn_failure: { code: "provider_error", retry_at: null },
        }),
      },
      ctx.db,
      deps,
    );
    expect(failed.run.state).toBe("failed");
    expect(seen.revocations).toEqual([[task.id, "grant_exhausted", null]]);
    expect((await grantRow(w.tenant_id, grantId)).revoked_at).not.toBeNull();
    await expect(rehydrate()).rejects.toBeDefined();
    expect(await start()).toEqual({ admitted: false, reason: "grant_required" });
    expect(seen.admissions).toEqual([
      "grant_required",
      "grant_fingerprint_mismatch",
      "previous_run_active",
      "grant_required",
    ]);
  });

  test("a ready result keeps the grant of the last run until it is confirmed", async () => {
    const w = await workspace();
    const task = await ownedTask(w, taskInput({ schedule_cron: "0 8 * * 1" }));
    const { deps } = recordingDeps();
    const grantId = await grantFor(w, task, { max_runs: 1 });
    const result = await startTaskRun(
      { tenant_id: w.tenant_id, task_id: task.id, trigger: "cron", started_by: SYSTEM_SCOPE },
      ctx.db,
      deps,
    );
    if (!result.admitted) throw new Error(result.reason);
    const ready = { playbook: facts({ awaiting_result_confirmation: true }) };
    const observe = (observation: Parameters<typeof observed>[0]) =>
      recordRunObservation(
        {
          tenant_id: w.tenant_id,
          task_run_id: result.run.id,
          observation: observed({ turn_id: nextTurn(), ...observation }),
        },
        ctx.db,
        deps,
      );
    const live = async () => (await grantRow(w.tenant_id, grantId)).revoked_at === null;
    expect((await observe(ready)).run.state).toBe("result_ready");
    expect(await live()).toBe(true);
    const reopened = await observe({ ...ready, turn_driver: "person", result_rejected: true });
    expect(reopened.run.state).toBe("running");
    expect(await live()).toBe(true);
    expect((await observe(ready)).run.state).toBe("running");
    const reworked = { playbook: facts({ awaiting_result_confirmation: true, revision: 3 }) };
    expect((await observe(reworked)).run.state).toBe("result_ready");
    expect(await live()).toBe(true);
    await completeTaskRun(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: result.run.id },
      ctx.db,
      deps,
    );
    expect(await live()).toBe(false);
  });

  test("a grant with runs left survives the end of a run", async () => {
    const w = await workspace();
    const task = await ownedTask(w, taskInput({ schedule_cron: "0 8 * * 1" }));
    const { deps } = recordingDeps();
    const grantId = await grantFor(w, task, { max_runs: 2 });
    const result = await startTaskRun(
      { tenant_id: w.tenant_id, task_id: task.id, trigger: "cron", started_by: SYSTEM_SCOPE },
      ctx.db,
      deps,
    );
    if (!result.admitted) throw new Error(result.reason);
    await recordRunObservation(
      {
        tenant_id: w.tenant_id,
        task_run_id: result.run.id,
        observation: observed({
          turn_id: nextTurn(),
          turn_failure: { code: "turn_failed", retry_at: null },
        }),
      },
      ctx.db,
      deps,
    );
    expect(await grantRow(w.tenant_id, grantId)).toMatchObject({
      reserved_runs: 1,
      revoked_at: null,
    });
  });

  test("paused tasks, unavailable owners and missing AI access do not start", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const start = (overrides: Partial<TaskServiceDeps> = {}) =>
      startTaskRun(
        { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.admin },
        ctx.db,
        { ...deps, ...overrides },
      );
    expect(await start({ aiAccessConfigured: async () => false })).toEqual({
      admitted: false,
      reason: "ai_access_missing",
    });
    await pauseTask({ tenant_id: w.tenant_id, principal: w.owner, task_id: task.id }, ctx.db, deps);
    expect(await start()).toEqual({ admitted: false, reason: "paused" });
    const other = await ownedTask(w, taskInput({ name: "Second" }));
    await ctx.db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.tenant_id, w.tenant_id), eq(users.id, w.owner.id)));
    expect(
      await startTaskRun(
        { tenant_id: w.tenant_id, task_id: other.id, trigger: "manual", started_by: w.admin },
        ctx.db,
        deps,
      ),
    ).toEqual({ admitted: false, reason: "owner_unavailable" });
  });
});
