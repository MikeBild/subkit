import { describe, expect, test } from "bun:test";
import { ConflictError, ForbiddenError, NotFoundError } from "../../http/errors.ts";
import {
  pauseTask,
  recordRunObservation,
  rejectTaskRunResult,
  type TaskRun,
  type TaskServiceDeps,
} from "../index.ts";
import {
  auditRows,
  ctx,
  facts,
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

useTaskDb("tasks_run_reject");

async function withResult(w: Workspace, deps: Partial<TaskServiceDeps>): Promise<TaskRun> {
  const run = await started(w, await ownedTask(w), deps);
  const ready = await recordRunObservation(
    {
      tenant_id: w.tenant_id,
      task_run_id: run.id,
      observation: observed({
        turn_id: nextTurn(),
        playbook: facts({ awaiting_result_confirmation: true }),
      }),
    },
    ctx.db,
    deps,
  );
  expect(ready.run.state).toBe("result_ready");
  return ready.run;
}

describe("tasks/service result rejection", () => {
  test("the owner sends a result back to work and is named in the audit row", async () => {
    const w = await workspace();
    const { deps, seen } = recordingDeps();
    const run = await withResult(w, deps);
    const rejected = await rejectTaskRunResult(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id, source: "api" },
      ctx.db,
      deps,
    );
    expect(rejected.enqueue).toBe(true);
    expect(rejected.run).toMatchObject({
      state: "running",
      result_ready_at: null,
      ended_at: null,
      no_progress_count: 0,
      turns_used: 1,
    });
    expect(seen.enqueued).toEqual([]);
    const [last] = (await auditRows(w.tenant_id, run.id)).slice(-1);
    expect(last).toMatchObject({
      action: "task_run.resumed",
      actor_type: "user",
      actor_id: w.owner.id,
      result: "success",
    });
    expect(last?.metadata).toMatchObject({
      task_id: run.task_id,
      task_run_id: run.id,
      previous_state: "result_ready",
      reason_code: "result_rejected",
      request_source: "api",
    });
  });

  test("an admin may reject, another member cannot see the run", async () => {
    const w = await workspace();
    const { deps } = recordingDeps();
    const run = await withResult(w, deps);
    const ref = { tenant_id: w.tenant_id, task_run_id: run.id };
    await expect(
      rejectTaskRunResult({ ...ref, principal: w.member }, ctx.db, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
    const rejected = await rejectTaskRunResult({ ...ref, principal: w.admin }, ctx.db, deps);
    expect(rejected.run.state).toBe("running");
    const [last] = (await auditRows(w.tenant_id, run.id)).slice(-1);
    expect(last).toMatchObject({ actor_type: "user", actor_id: w.admin.id });
  });

  test("only a person rejects, and only a run with a result", async () => {
    const w = await workspace();
    const { deps } = recordingDeps();
    const run = await withResult(w, deps);
    const ref = { tenant_id: w.tenant_id, task_run_id: run.id };
    await expect(
      rejectTaskRunResult(
        { ...ref, principal: { ...w.owner, kind: "system_account" } },
        ctx.db,
        deps,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await rejectTaskRunResult({ ...ref, principal: w.owner }, ctx.db, deps);
    const again = rejectTaskRunResult({ ...ref, principal: w.owner }, ctx.db, deps);
    await expect(again).rejects.toBeInstanceOf(ConflictError);
    await expect(again).rejects.toMatchObject({ details: { state: "running" } });
  });

  test("a paused task or a newer open run keeps the result where it is", async () => {
    const w = await workspace();
    const { deps } = recordingDeps();
    const run = await withResult(w, deps);
    await pauseTask(
      { tenant_id: w.tenant_id, principal: w.owner, task_id: run.task_id },
      ctx.db,
      deps,
    );
    const before = (await auditRows(w.tenant_id, run.id)).length;
    const blocked = rejectTaskRunResult(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id },
      ctx.db,
      deps,
    );
    await expect(blocked).rejects.toMatchObject({
      details: { code: "task_run_reopen_blocked", state: "result_ready" },
    });
    expect(await auditRows(w.tenant_id, run.id)).toHaveLength(before);
  });

  test("a run past its turn limit waits for the person instead of running on", async () => {
    const w = await workspace();
    const { deps } = recordingDeps();
    const task = await ownedTask(w, taskInput({ max_turns: 1 }));
    const run = await started(w, task, deps);
    await recordRunObservation(
      {
        tenant_id: w.tenant_id,
        task_run_id: run.id,
        observation: observed({
          turn_id: nextTurn(),
          playbook: facts({ awaiting_result_confirmation: true }),
        }),
      },
      ctx.db,
      deps,
    );
    const rejected = await rejectTaskRunResult(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id },
      ctx.db,
      deps,
    );
    expect(rejected.enqueue).toBe(false);
    expect(rejected.run).toMatchObject({ state: "waiting", waiting_reason: "no_progress" });
    const [last] = (await auditRows(w.tenant_id, run.id)).slice(-1);
    expect(last).toMatchObject({ action: "task_run.waiting", actor_id: w.owner.id });
    expect(last?.metadata).toMatchObject({ reason_code: "result_rejected" });
  });
});
