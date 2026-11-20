import { describe, expect, test } from "bun:test";
import {
  readTaskRunPlaybook,
  recordRunObservation,
  resumeTaskRun,
  startTaskRun,
  type TaskRunObservation,
  type TaskServiceDeps,
  taskRunPrincipal,
} from "../index.ts";
import {
  auditRows,
  ctx,
  facts,
  NOW,
  nextTurn,
  observed,
  ownedTask,
  recordingDeps,
  started,
  taskInput,
  useTaskDb,
  type Workspace,
  workspace,
} from "./fixtures.ts";

useTaskDb("tasks_run_observe");

function observer(w: Workspace, run_id: string, deps: Partial<TaskServiceDeps>) {
  return (observation: Partial<TaskRunObservation> = {}) =>
    recordRunObservation(
      {
        tenant_id: w.tenant_id,
        task_run_id: run_id,
        observation: observed({ turn_id: nextTurn(), ...observation }),
      },
      ctx.db,
      deps,
    );
}

describe("tasks/service observing runs", () => {
  test("an observation moves the run, audits only on a state change and ignores a repeated turn", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps, seen } = recordingDeps();
    const run = await started(w, task, deps);
    const observe = observer(w, run.id, deps);
    const turn = nextTurn();
    const running = await observe({ turn_id: turn });
    expect(running).toMatchObject({ changed: false, enqueue: true });
    expect(running.run).toMatchObject({ state: "running", turns_used: 1, last_seen_turn_id: turn });
    const repeated = await observe({ turn_id: turn, pending_elicitation: "question" });
    expect(repeated).toMatchObject({ changed: false, enqueue: false });
    expect(repeated.run).toMatchObject({ state: "running", turns_used: 1 });
    const waiting = await observe({ turn_id: null, pending_elicitation: "question" });
    expect(waiting.run).toMatchObject({
      state: "waiting",
      waiting_reason: "question",
      turns_used: 1,
      last_seen_turn_id: turn,
      ended_at: null,
    });
    const approval = await observe({ turn_id: null, pending_elicitation: "approval" });
    expect(approval).toMatchObject({ changed: false });
    expect(approval.run.waiting_reason).toBe("approval");
    const resumed = await resumeTaskRun(
      { tenant_id: w.tenant_id, task_run_id: run.id, source: "queue" },
      ctx.db,
      deps,
    );
    expect(resumed.resumed).toBe(true);
    expect(resumed.run).toMatchObject({ state: "running", waiting_reason: null });
    expect(
      (await resumeTaskRun({ tenant_id: w.tenant_id, task_run_id: run.id }, ctx.db, deps)).resumed,
    ).toBe(false);
    const check = new Date(NOW.getTime() + 3_600_000);
    const sleeping = await observe({ requested_check_at: check });
    expect(sleeping.run).toMatchObject({
      state: "sleeping",
      next_check_at: check.toISOString(),
      sleep_reason: "check_requested",
      turns_used: 2,
    });
    expect(seen.cleared).toEqual([run.conversation_id ?? ""]);
    await resumeTaskRun({ tenant_id: w.tenant_id, task_run_id: run.id }, ctx.db, deps);
    const failed = await observe({ turn_failure: { code: "Provider Error", retry_at: null } });
    expect(failed.run).toMatchObject({
      state: "failed",
      failure_code: "turn_failed",
      ended_at: NOW.toISOString(),
      sleep_reason: null,
      next_check_at: null,
    });
    expect((await observe()).changed).toBe(false);
    const audit = await auditRows(w.tenant_id, run.id);
    expect(audit.map((entry) => [entry.action, entry.result, entry.reason])).toEqual([
      ["task_run.started", "success", null],
      ["task_run.waiting", "success", "question"],
      ["task_run.resumed", "success", null],
      ["task_run.waiting", "success", null],
      ["task_run.resumed", "success", null],
      ["task_run.failed", "error", null],
    ]);
    const details = audit.map((entry) => entry.metadata);
    expect(details[1]).toMatchObject({
      state: "waiting",
      waiting_reason: "question",
      turns_used: 1,
    });
    expect(details[2]).toMatchObject({ previous_state: "waiting", resume_reason: "approval" });
    expect(details[3]).toMatchObject({ state: "sleeping", sleep_reason: "check_requested" });
    expect(details[4]).toMatchObject({
      previous_state: "sleeping",
      resume_reason: "check_requested",
    });
    expect(details[5]).toMatchObject({
      task_id: task.id,
      task_run_id: run.id,
      previous_state: "running",
      failure_code: "turn_failed",
      turns_used: 3,
      duration_ms: 0,
    });
    expect(seen.webhooks).toEqual(["task_run.started", "task_run.waiting", "task_run.failed"]);
    expect(seen.payloads.slice(1)).toEqual([
      { task_run_id: run.id, task_id: task.id, trigger: "manual", waiting_reason: "question" },
      { task_run_id: run.id, task_id: task.id, trigger: "manual", failure_code: "turn_failed" },
    ]);
    expect(seen.outcomes).toEqual(["started", "failed"]);
  });

  test("a plan the model reshaped fails the run instead of completing it", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const shapes = [
      facts({ intact: false, status: "completed", result_confirmed: true }),
      facts({ intact: false, awaiting_result_confirmation: true }),
      facts({ status: "completed", result_confirmed: false }),
    ];
    for (const playbook of shapes) {
      const run = await started(w, task, deps);
      const result = await observer(w, run.id, deps)({ playbook });
      expect(result.run).toMatchObject({ state: "failed", failure_code: "playbook_tampered" });
    }
  });

  test("the stored plan decides whether a run conversation's playbook is intact", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const run = await started(w, task, deps);
    const principal = taskRunPrincipal(
      { tenant_id: w.tenant_id, owner_id: task.owner_id, id: task.id, bindings: task.bindings },
      { active: true, roles: ["member"], email: null },
      { id: run.id, grant_id: null },
    );
    const read = (goal: string) =>
      readTaskRunPlaybook(
        { tenant_id: w.tenant_id, conversation_id: run.conversation_id ?? "", principal, goal },
        ctx.db,
      );
    expect(await read(task.goal)).toEqual({
      status: "blocked",
      revision: 1,
      intact: true,
      result_confirmed: false,
      awaiting_result_confirmation: false,
    });
    expect((await read("Another goal"))?.intact).toBe(false);
  });

  test("a confirmation in chat completes a ready run and records the person", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const run = await started(w, task, deps);
    const observe = observer(w, run.id, deps);
    expect(
      (await observe({ playbook: facts({ awaiting_result_confirmation: true }) })).run.state,
    ).toBe("result_ready");
    expect(await observe()).toMatchObject({ changed: false, enqueue: false });
    const anonymous = await observe({
      turn_driver: "person",
      playbook: facts({ status: "completed", result_confirmed: true, revision: 3 }),
    });
    expect(anonymous).toMatchObject({ changed: false, run: { state: "result_ready" } });
    const done = await observe({
      turn_driver: "person",
      human_input_since_last_turn: true,
      result_confirmed_by: w.admin.id,
      playbook: facts({ status: "completed", result_confirmed: true, revision: 3 }),
    });
    expect(done.run).toMatchObject({
      state: "completed",
      completed_at: NOW.toISOString(),
      completed_by: w.admin.id,
      result_ready_at: NOW.toISOString(),
      turns_used: 1,
    });
    expect(
      (await auditRows(w.tenant_id, run.id)).map((entry) => [
        entry.action,
        entry.actor_type,
        entry.actor_id,
      ]),
    ).toEqual([
      ["task_run.started", "user", w.owner.id],
      ["task_run.result_ready", "system", null],
      ["task_run.completed", "user", w.admin.id],
    ]);
  });

  test("a rejected result reopens the run unless another run of the task is open", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps, seen } = recordingDeps();
    const ready = { playbook: facts({ awaiting_result_confirmation: true }) };
    const rejected = { ...ready, turn_driver: "person" as const, result_rejected: true };
    const first = await started(w, task, deps);
    await observer(w, first.id, deps)(ready);
    const reopened = await observer(w, first.id, deps)(rejected);
    expect(reopened).toMatchObject({ changed: true, enqueue: true });
    expect(reopened.run).toMatchObject({
      state: "running",
      result_ready_at: null,
      ended_at: null,
      no_progress_count: 0,
    });
    const unchanged = await observer(w, first.id, deps)(ready);
    expect(unchanged.run.state).toBe("running");
    await observer(
      w,
      first.id,
      deps,
    )({
      playbook: facts({ awaiting_result_confirmation: true, revision: 3 }),
    });
    const second = await started(w, task, deps);
    const kept = await observer(w, first.id, deps)(rejected);
    expect(kept).toMatchObject({ changed: false, enqueue: false });
    expect(kept.run.state).toBe("result_ready");
    expect(
      await startTaskRun(
        { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.owner },
        ctx.db,
        deps,
      ),
    ).toEqual({ admitted: false, reason: "previous_run_active" });
    expect(second.state).toBe("running");
    expect(seen.webhooks.filter((type) => type === "task_run.result_ready")).toHaveLength(2);
    expect((await auditRows(w.tenant_id, first.id)).map((entry) => entry.action)).toEqual([
      "task_run.started",
      "task_run.result_ready",
      "task_run.resumed",
      "task_run.result_ready",
    ]);
  });

  test("answers reset the stall counter and turns a person drives are free", async () => {
    const w = await workspace();
    const task = await ownedTask(w, taskInput({ max_turns: 3 }));
    const { deps } = recordingDeps();
    const run = await started(w, task, deps);
    const observe = observer(w, run.id, deps);
    const same = { playbook: facts({ revision: 1 }) };
    expect((await observe({ playbook: facts({ revision: 1 }) })).run).toMatchObject({
      state: "running",
      turns_used: 1,
      no_progress_count: 0,
    });
    expect((await observe(same)).run).toMatchObject({ state: "running", no_progress_count: 1 });
    const answered = await observe({
      ...same,
      turn_driver: "person",
      human_input_since_last_turn: true,
    });
    expect(answered.run).toMatchObject({ state: "running", turns_used: 2, no_progress_count: 0 });
    const last = await observe(same);
    expect(last.run).toMatchObject({
      state: "waiting",
      waiting_reason: "no_progress",
      turns_used: 3,
    });
    const refused = await resumeTaskRun(
      { tenant_id: w.tenant_id, task_run_id: run.id },
      ctx.db,
      deps,
    );
    expect(refused).toMatchObject({ resumed: false, run: { state: "waiting" } });
  });

  test("a sleeping run past its deadline wakes into waiting, and a wake keeps the stall counter", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const run = await started(w, task, deps);
    const observe = observer(w, run.id, deps);
    const far = new Date(NOW.getTime() + 10 * 86_400_000);
    const same = { playbook: facts({ revision: 0 }) };
    const slept = await observe({ ...same, requested_check_at: far });
    expect(slept.run).toMatchObject({
      state: "sleeping",
      next_check_at: run.deadline_at,
      no_progress_count: 1,
    });
    const woken = await resumeTaskRun(
      { tenant_id: w.tenant_id, task_run_id: run.id },
      ctx.db,
      deps,
    );
    expect(woken).toMatchObject({ resumed: true, run: { state: "running", no_progress_count: 1 } });
    await observe({ ...same, requested_check_at: far });
    const late = { ...deps, now: () => new Date(run.deadline_at) };
    const expired = await resumeTaskRun(
      { tenant_id: w.tenant_id, task_run_id: run.id },
      ctx.db,
      late,
    );
    expect(expired).toMatchObject({
      resumed: false,
      run: { state: "waiting", waiting_reason: "no_progress", next_check_at: null },
    });
  });

  test("a running run whose result is confirmed without a known person only becomes ready", async () => {
    const w = await workspace();
    const { deps } = recordingDeps();
    const run = await started(w, await ownedTask(w), deps);
    const result = await observer(
      w,
      run.id,
      deps,
    )({
      playbook: facts({ status: "completed", result_confirmed: true }),
    });
    expect(result.run).toMatchObject({ state: "result_ready", completed_by: null });
    expect((await auditRows(w.tenant_id, run.id)).map((entry) => entry.action)).toEqual([
      "task_run.started",
      "task_run.result_ready",
    ]);
  });
});
