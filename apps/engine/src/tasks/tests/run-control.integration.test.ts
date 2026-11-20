import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, taskRuns, tasks } from "../../db/schema/index.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "../../http/errors.ts";
import {
  abortTaskRun,
  completeTaskRun,
  defaultTaskServiceDeps,
  deleteTask,
  failStalledStarts,
  getTaskRun,
  getTaskRunByConversation,
  listTaskRuns,
  recordRunObservation,
  recordTaskAdmissionChange,
  resumeTaskRun,
  SYSTEM_SCOPE,
  startTaskRun,
  type TaskPrincipal,
  type TaskServiceDeps,
} from "../index.ts";
import {
  auditRows,
  conversationRow,
  ctx,
  facts,
  NOW,
  nextTurn,
  observed,
  ownedTask,
  recordingDeps,
  started,
  useTaskDb,
  workspace,
} from "./fixtures.ts";

useTaskDb("tasks_run_control");

describe("tasks/service run control", () => {
  test("abort marks the run, records who asked and closes the conversation", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    let cancels = 0;
    const { deps, seen } = recordingDeps({
      cancelRunConversation: async (db, params) => {
        cancels++;
        await defaultTaskServiceDeps.cancelRunConversation(db, params);
      },
    });
    const run = await started(w, task, deps);
    const foreign = await abortTaskRun(
      { tenant_id: w.tenant_id, principal: w.member, task_run_id: run.id },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(foreign).toBeInstanceOf(NotFoundError);
    const byAdmin = { tenant_id: w.tenant_id, principal: w.admin, task_run_id: run.id };
    const aborted = await abortTaskRun(byAdmin, ctx.db, deps);
    expect(aborted).toMatchObject({ state: "aborted", ended_at: NOW.toISOString() });
    expect((await conversationRow(w.tenant_id, run.conversation_id ?? "")).status).toBe(
      "abandoned",
    );
    await abortTaskRun(byAdmin, ctx.db, deps);
    expect(cancels).toBe(1);
    await ctx.db
      .update(conversations)
      .set({ status: "active" })
      .where(
        and(
          eq(conversations.tenant_id, w.tenant_id),
          eq(conversations.id, run.conversation_id ?? ""),
        ),
      );
    await abortTaskRun(byAdmin, ctx.db, deps);
    expect(cancels).toBe(2);
    expect((await conversationRow(w.tenant_id, run.conversation_id ?? "")).status).toBe(
      "abandoned",
    );
    expect(
      (await auditRows(w.tenant_id, run.id)).map((entry) => [
        entry.action,
        entry.actor_type,
        entry.actor_id,
      ]),
    ).toEqual([
      ["task_run.started", "user", w.owner.id],
      ["task_run.abort_requested", "user", w.admin.id],
      ["task_run.aborted", "system", null],
    ]);
    expect(seen.outcomes).toEqual(["started", "aborted"]);
    const next = await started(w, task, deps);
    await recordRunObservation(
      {
        tenant_id: w.tenant_id,
        task_run_id: next.id,
        observation: observed({
          turn_id: nextTurn(),
          playbook: facts({ status: "completed", result_confirmed: true }),
        }),
      },
      ctx.db,
      deps,
    );
    const ended = await abortTaskRun({ ...byAdmin, task_run_id: next.id }, ctx.db, deps).catch(
      (e) => e,
    );
    expect(ended).toBeInstanceOf(ConflictError);
  });

  test("deleting a task archives it and aborts its open run", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const run = await started(w, task, deps);
    await deleteTask(
      { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id },
      ctx.db,
      deps,
    );
    const after = await getTaskRun(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id },
      ctx.db,
    );
    expect(after).toMatchObject({ state: "aborted", failure_code: "task_archived" });
    expect((await conversationRow(w.tenant_id, run.conversation_id ?? "")).status).toBe(
      "abandoned",
    );
    const restart = await startTaskRun(
      { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.owner },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(restart).toBeInstanceOf(NotFoundError);
  });

  test("a start that cannot finish leaves a failed run and a closed conversation", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    await ctx.db
      .update(tasks)
      .set({ plan: {} })
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    const { deps, seen } = recordingDeps();
    const start = () =>
      startTaskRun(
        { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.owner },
        ctx.db,
        deps,
      );
    expect(await start().catch((e) => e)).toBeInstanceOf(Error);
    const [run] = await listTaskRuns(
      { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id },
      ctx.db,
    );
    expect(run).toMatchObject({
      state: "failed",
      failure_code: "start_failed",
      ended_at: NOW.toISOString(),
    });
    expect(run?.conversation_id).not.toBeNull();
    expect((await conversationRow(w.tenant_id, run?.conversation_id ?? "")).status).toBe(
      "abandoned",
    );
    expect(
      (await auditRows(w.tenant_id, run?.id ?? "")).map((entry) => [entry.action, entry.result]),
    ).toEqual([
      ["task_run.started", "success"],
      ["task_run.failed", "error"],
    ]);
    expect(seen.webhooks).toEqual(["task_run.started", "task_run.failed"]);
    expect(seen.outcomes).toEqual(["started", "failed"]);
    expect(await start().catch((e) => e)).toBeInstanceOf(Error);
  });

  test("a run aborted while its conversation is being opened is not reported as started", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps, seen } = recordingDeps();
    const racing: Partial<TaskServiceDeps> = {
      ...deps,
      recordTaskRunOutcome: (args) => {
        seen.outcomes.push(args.outcome);
        if (args.outcome !== "started") return;
        return listTaskRuns(
          { tenant_id: w.tenant_id, principal: SYSTEM_SCOPE, task_id: task.id },
          ctx.db,
        ).then(([open]) =>
          abortTaskRun(
            { tenant_id: w.tenant_id, principal: w.admin, task_run_id: open?.id ?? "" },
            ctx.db,
            deps,
          ),
        );
      },
    };
    const result = await startTaskRun(
      { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.owner },
      ctx.db,
      racing,
    );
    expect(result).toMatchObject({
      admitted: false,
      reason: "run_ended",
      run: { state: "aborted", conversation_id: null },
    });
    const run = "run" in result ? result.run : null;
    expect((await auditRows(w.tenant_id, run?.id ?? "")).map((entry) => entry.action)).toEqual([
      "task_run.started",
      "task_run.abort_requested",
      "task_run.aborted",
    ]);
    expect(seen.outcomes).toEqual(["started", "aborted"]);
    expect(seen.webhooks).toEqual(["task_run.started"]);
    const orphans = await ctx.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.tenant_id, w.tenant_id));
    expect(orphans).toEqual([{ status: "abandoned" }]);
  });

  test("confirming a result re-reads the plan and refuses one that was reshaped", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const ready = async () => {
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
      return run;
    };
    const intact = await ready();
    const confirm = { tenant_id: w.tenant_id, principal: w.owner };
    const machine = { ...w.owner, kind: "system_account" as const };
    const byMachine = await completeTaskRun(
      { ...confirm, principal: machine, task_run_id: intact.id },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(byMachine).toBeInstanceOf(ForbiddenError);
    expect(
      (await completeTaskRun({ ...confirm, task_run_id: intact.id }, ctx.db, deps)).state,
    ).toBe("completed");
    const reshaped = await ready();
    const row = await conversationRow(w.tenant_id, reshaped.conversation_id ?? "");
    const document = row.playbook as { plan: { goal: string } };
    await ctx.db
      .update(conversations)
      .set({ playbook: { ...document, plan: { ...document.plan, goal: "Something easier" } } })
      .where(and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, row.id)));
    const refused = await completeTaskRun(
      { ...confirm, task_run_id: reshaped.id },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused.details).toEqual({ code: "playbook_tampered", state: "failed" });
    expect(await getTaskRun({ ...confirm, task_run_id: reshaped.id }, ctx.db)).toMatchObject({
      state: "failed",
      failure_code: "playbook_tampered",
      completed_by: null,
    });
  });

  test("the sweep fails starts that never got a conversation", async () => {
    const w = await workspace();
    const other = await workspace();
    const { deps } = recordingDeps();
    const stalled = await started(w, await ownedTask(w), deps);
    const healthy = await started(w, await ownedTask(w), deps);
    const foreign = await started(other, await ownedTask(other), deps);
    for (const [tenant_id, id] of [
      [w.tenant_id, stalled.id],
      [other.tenant_id, foreign.id],
    ] as const)
      await ctx.db
        .update(taskRuns)
        .set({ conversation_id: null })
        .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, id)));
    expect(await failStalledStarts(w.tenant_id, NOW, ctx.db, deps)).toEqual([]);
    const later = new Date(NOW.getTime() + 1);
    expect(await failStalledStarts(w.tenant_id, later, ctx.db, deps)).toEqual([stalled.id]);
    expect(await failStalledStarts(w.tenant_id, later, ctx.db, deps)).toEqual([]);
    const state = async (tenant_id: string, id: string) =>
      (await getTaskRun({ tenant_id, principal: SYSTEM_SCOPE, task_run_id: id }, ctx.db))?.state;
    expect(await state(w.tenant_id, stalled.id)).toBe("failed");
    expect(await state(w.tenant_id, healthy.id)).toBe("running");
    expect(await state(other.tenant_id, foreign.id)).toBe("running");
    expect((await auditRows(w.tenant_id, stalled.id)).at(-1)).toMatchObject({
      action: "task_run.failed",
      actor_type: "system",
      result: "error",
    });
  });

  test("an admission change is audited only when it changes", async () => {
    const w = await workspace();
    const task = await ownedTask(w);
    const change = (reason: Parameters<typeof recordTaskAdmissionChange>[1]["reason"]) =>
      ctx.db.transaction((tx) =>
        recordTaskAdmissionChange(tx, {
          tenant_id: w.tenant_id,
          task_id: task.id,
          trigger: "cron",
          reason,
          at: new Date(NOW.getTime() + ++tick),
        }),
      );
    let tick = 0;
    expect(await change(null)).toBe(false);
    expect(await change("grant_required")).toBe(true);
    expect(await change("grant_required")).toBe(false);
    expect(await change("previous_run_active")).toBe(true);
    expect(await change(null)).toBe(true);
    expect(await change(null)).toBe(false);
    const rows = (await auditRows(w.tenant_id, task.id)).filter(
      (entry) => entry.action === "task.admission.changed",
    );
    expect(rows.map((entry) => [entry.actor_type, entry.result, entry.reason])).toEqual([
      ["system", "denied", "grant_required"],
      ["system", "denied", "previous_run_active"],
      ["system", "success", null],
    ]);
    expect(rows.map((entry) => entry.metadata)).toMatchObject([
      { task_id: task.id, state: "held", reason_code: "grant_required", trigger: "cron" },
      { state: "held", reason_code: "previous_run_active" },
      { state: "admitted", reason_code: null },
    ]);
  });

  test("runs are invisible to other members and other workspaces", async () => {
    const w = await workspace();
    const other = await workspace();
    const task = await ownedTask(w);
    const { deps } = recordingDeps();
    const run = await started(w, task, deps);
    const read = (tenant_id: string, principal: TaskPrincipal) =>
      getTaskRun({ tenant_id, principal, task_run_id: run.id }, ctx.db);
    expect((await read(w.tenant_id, w.owner))?.id).toBe(run.id);
    expect((await read(w.tenant_id, w.admin))?.id).toBe(run.id);
    expect((await read(w.tenant_id, SYSTEM_SCOPE))?.id).toBe(run.id);
    expect(await read(w.tenant_id, w.member)).toBeNull();
    expect(await read(other.tenant_id, other.admin)).toBeNull();
    expect(await read(other.tenant_id, SYSTEM_SCOPE)).toBeNull();
    const elsewhere = { tenant_id: other.tenant_id, task_run_id: run.id };
    const attempts = [
      () =>
        startTaskRun(
          { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.member },
          ctx.db,
          deps,
        ),
      () =>
        startTaskRun(
          {
            tenant_id: other.tenant_id,
            task_id: task.id,
            trigger: "cron",
            started_by: SYSTEM_SCOPE,
          },
          ctx.db,
          deps,
        ),
      () =>
        completeTaskRun(
          { tenant_id: w.tenant_id, principal: w.member, task_run_id: run.id },
          ctx.db,
          deps,
        ),
      () => abortTaskRun({ ...elsewhere, principal: other.admin }, ctx.db, deps),
      () => resumeTaskRun(elsewhere, ctx.db, deps),
      () => recordRunObservation({ ...elsewhere, observation: observed() }, ctx.db, deps),
    ];
    for (const attempt of attempts)
      expect(await attempt().catch((e) => e)).toBeInstanceOf(NotFoundError);
    expect(
      await getTaskRunByConversation(
        {
          tenant_id: other.tenant_id,
          principal: SYSTEM_SCOPE,
          conversation_id: run.conversation_id ?? "",
        },
        ctx.db,
      ),
    ).toBeNull();
    expect((await read(w.tenant_id, w.owner))?.state).toBe("running");
  });
});
