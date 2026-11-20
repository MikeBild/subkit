import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { taskRuns, tasks } from "../../db/schema/index.ts";
import {
  getTaskRun,
  pauseTask,
  pauseTasksOfOwner,
  recordRunObservation,
  resumeTask,
  resumeTaskRun,
  SYSTEM_SCOPE,
  updateTask,
} from "../index.ts";
import {
  auditRows,
  conversationRow,
  ctx,
  grantFor,
  grantRow,
  nextTurn,
  observed,
  ownedTask,
  recordingDeps,
  started,
  taskInput,
  useTaskDb,
  workspace,
} from "./fixtures.ts";

useTaskDb("tasks_run_lifecycle");

describe("tasks/service runs follow their task", () => {
  test("pausing a task puts its run to sleep and resuming continues it", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps, seen } = recordingDeps();
    const run = await started(w, task, deps);
    const scope = { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id };
    const ref = { tenant_id: w.tenant_id, task_run_id: run.id };
    await pauseTask(scope, ctx.db, deps);
    const slept = await getTaskRun({ ...ref, principal: w.owner }, ctx.db);
    expect(slept).toMatchObject({ state: "sleeping", sleep_reason: "paused", next_check_at: null });
    expect(seen.turn_cancels).toEqual([run.conversation_id ?? ""]);
    expect((await conversationRow(w.tenant_id, run.conversation_id ?? "")).status).toBe("active");
    const late = await recordRunObservation(
      { ...ref, observation: observed({ turn_id: nextTurn() }) },
      ctx.db,
      deps,
    );
    expect(late).toMatchObject({ changed: false, enqueue: false });
    expect(late.run).toMatchObject({ state: "sleeping", sleep_reason: "paused", turns_used: 1 });
    for (const cancelled of [
      { turn_interrupted: true },
      { turn_failure: { code: "turn_failed", retry_at: null } },
    ]) {
      const kept = await recordRunObservation(
        { ...ref, observation: observed({ turn_id: nextTurn(), ...cancelled }) },
        ctx.db,
        deps,
      );
      expect(kept).toMatchObject({ changed: false, enqueue: false });
      expect(kept.run).toMatchObject({ state: "sleeping", sleep_reason: "paused" });
    }
    expect(await resumeTaskRun(ref, ctx.db, deps)).toMatchObject({ resumed: false });
    const resumed = await resumeTask(scope, ctx.db, deps);
    expect(resumed).toMatchObject({
      task: { paused_at: null },
      run: { id: run.id, state: "running", sleep_reason: null },
      enqueue: true,
    });
    expect(seen.enqueued).toEqual([run.id]);
    const again = await resumeTask(scope, ctx.db, deps);
    expect(again).toMatchObject({ enqueue: true, run: { state: "running" } });
    expect(seen.enqueued).toEqual([run.id, run.id]);
    const audit = await auditRows(w.tenant_id, run.id);
    expect(audit.map((entry) => [entry.action, entry.reason])).toEqual([
      ["task_run.started", null],
      ["task_run.waiting", "paused"],
      ["task_run.resumed", null],
    ]);
    expect(audit[1]?.metadata).toMatchObject({ state: "sleeping", sleep_reason: "paused" });
    expect(audit[2]?.metadata).toMatchObject({
      previous_state: "sleeping",
      resume_reason: "paused",
    });
  });

  test("an answer that arrives while the task is paused does not continue the run", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps, seen } = recordingDeps();
    const run = await started(w, task, deps);
    const scope = { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id };
    const ref = { tenant_id: w.tenant_id, task_run_id: run.id };
    await recordRunObservation(
      { ...ref, observation: observed({ turn_id: nextTurn(), pending_elicitation: "question" }) },
      ctx.db,
      deps,
    );
    await pauseTask(scope, ctx.db, deps);
    expect(seen.turn_cancels).toEqual([]);
    expect(await resumeTaskRun(ref, ctx.db, deps)).toMatchObject({
      resumed: false,
      run: { state: "waiting" },
    });
    const answered = await recordRunObservation(
      {
        ...ref,
        observation: observed({
          turn_id: nextTurn(),
          turn_driver: "person",
          human_input_since_last_turn: true,
        }),
      },
      ctx.db,
      deps,
    );
    expect(answered).toMatchObject({ enqueue: false });
    expect(answered.run).toMatchObject({ state: "sleeping", sleep_reason: "paused" });
    expect(await resumeTask(scope, ctx.db, deps)).toMatchObject({ enqueue: true });
  });

  test("resuming a paused task does not continue a run that is out of turns", async () => {
    const w = await workspace();
    const task = await ownedTask(w, taskInput({ max_turns: 5 }));
    const { deps, seen } = recordingDeps();
    const run = await started(w, task, deps);
    const scope = { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id };
    await pauseTask(scope, ctx.db, deps);
    await ctx.db
      .update(taskRuns)
      .set({ turns_used: 5 })
      .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.id, run.id)));
    const resumed = await resumeTask(scope, ctx.db, deps);
    expect(resumed).toMatchObject({
      enqueue: false,
      run: { state: "waiting", waiting_reason: "no_progress" },
    });
    expect(seen.enqueued).toEqual([]);
  });

  test("a content change aborts the open run, revokes the grant and says so", async () => {
    const w = await workspace();
    const task = await ownedTask(w, taskInput({ schedule_cron: "0 8 * * 1" }));
    const { deps } = recordingDeps();
    const grantId = await grantFor(w, task);
    const run = await started(w, task, deps);
    const scope = { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id };
    const base = taskInput({ schedule_cron: "0 8 * * 1" });
    const renamed = await updateTask(
      { ...scope, input: { ...base, name: "Renamed", expected_revision: 1 } },
      ctx.db,
      deps,
    );
    expect(renamed.aborted_run_id).toBeNull();
    expect((await grantRow(w.tenant_id, grantId)).revoked_at).toBeNull();
    const changed = await updateTask(
      { ...scope, input: { ...base, goal: "Send it twice", expected_revision: 2 } },
      ctx.db,
      deps,
    );
    expect(changed).toMatchObject({ grant_invalidated: true, aborted_run_id: run.id });
    const after = await getTaskRun(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id },
      ctx.db,
    );
    expect(after).toMatchObject({ state: "aborted", failure_code: "task_changed" });
    expect((await conversationRow(w.tenant_id, run.conversation_id ?? "")).status).toBe(
      "abandoned",
    );
    expect(await grantRow(w.tenant_id, grantId)).toMatchObject({ revoked_by: w.owner.id });
    expect((await grantRow(w.tenant_id, grantId)).revoked_at).not.toBeNull();
    expect(
      (await auditRows(w.tenant_id, run.id)).map((entry) => [entry.action, entry.actor_type]),
    ).toEqual([
      ["task_run.started", "user"],
      ["task_run.abort_requested", "user"],
      ["task_run.aborted", "system"],
    ]);
  });

  test("a run whose task changed underneath it ends at the next observation or wake", async () => {
    const w = await workspace();
    const { deps } = recordingDeps();
    const stale = async () => {
      const task = await ownedTask(w);
      const run = await started(w, task, deps);
      await ctx.db
        .update(tasks)
        .set({ fingerprint: "e".repeat(64) })
        .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
      return { tenant_id: w.tenant_id, task_run_id: run.id };
    };
    const observedRun = await recordRunObservation(
      { ...(await stale()), observation: observed({ turn_id: nextTurn() }) },
      ctx.db,
      deps,
    );
    expect(observedRun).toMatchObject({ changed: true, enqueue: false });
    expect(observedRun.run).toMatchObject({ state: "aborted", failure_code: "task_changed" });
    const woken = await resumeTaskRun(await stale(), ctx.db, deps);
    expect(woken).toMatchObject({
      resumed: false,
      run: { state: "aborted", failure_code: "task_changed" },
    });
  });

  test("removing the owner ends their open runs", async () => {
    const w = await workspace();
    const task = await ownedTask(w, taskInput({ schedule_cron: "0 8 * * 1" }));
    const { deps } = recordingDeps();
    const grantId = await grantFor(w, task);
    const run = await started(w, task, deps);
    expect(await pauseTasksOfOwner(w.tenant_id, w.owner.id, ctx.db, deps)).toEqual([task.id]);
    const after = await getTaskRun(
      { tenant_id: w.tenant_id, principal: SYSTEM_SCOPE, task_run_id: run.id },
      ctx.db,
    );
    expect(after).toMatchObject({ state: "aborted", failure_code: "owner_unavailable" });
    expect((await conversationRow(w.tenant_id, run.conversation_id ?? "")).status).toBe(
      "abandoned",
    );
    expect((await grantRow(w.tenant_id, grantId)).revoked_at).not.toBeNull();
    expect(
      (await auditRows(w.tenant_id, run.id)).map((entry) => [
        entry.action,
        entry.actor_type,
        entry.reason,
      ]),
    ).toEqual([
      ["task_run.started", "user", null],
      ["task_run.aborted", "system", "owner_unavailable"],
    ]);
  });
});
