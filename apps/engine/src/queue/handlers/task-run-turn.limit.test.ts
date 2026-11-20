import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { updatePlaybook } from "../../conversations/public/authoring.ts";
import { conversations, taskRuns } from "../../db/schema/index.ts";
import { resumeTaskRun, startTaskRun } from "../../tasks/index.ts";
import { advanceTaskRun } from "../../tasks/run-driver.ts";
import { enqueueTaskRunTurn } from "./task-run-turn.ts";
import {
  auditOf,
  clearQueue,
  db,
  jobOf,
  ownedTask,
  queuedJobs,
  runRow,
  type StartedRun,
  script,
  startedRun,
  storedPlan,
  taskInput,
  useTaskRunQueue,
  type Workspace,
  workQueuedTurn,
  workspace,
} from "./task-run-turn-fixtures.ts";

useTaskRunQueue("task_run_turn_limit");

const SWEEP_AT = new Date("2027-01-01T00:00:00.000Z");
const SUMMARY = "In Berlin sind es 3,8 °C bei leichtem Wind.";

async function queuedRun(w: Workspace, max_turns: number): Promise<StartedRun> {
  const run = await startedRun(w, await ownedTask(w, taskInput({ max_turns })));
  await clearQueue();
  await enqueueTaskRunTurn(db, jobOf(w, run));
  return run;
}

async function parkedResult(w: Workspace, run: StartedRun) {
  const plan = await storedPlan(w, run.conversation_id);
  const [row] = await db
    .select({ revision: conversations.playbook_revision })
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, run.conversation_id)),
    );
  return {
    expected_revision: row?.revision ?? 0,
    plan: {
      ...plan,
      steps: plan.steps.map((step) =>
        step.criterion.kind === "assessment"
          ? {
              ...step,
              progress: "waiting_for_input" as const,
              criterion: { ...step.criterion, result: SUMMARY },
            }
          : { ...step, progress: "blocked" as const },
      ),
    },
  };
}

async function storedAsStuck(w: Workspace, run: StartedRun): Promise<void> {
  await db
    .update(taskRuns)
    .set({
      state: "waiting",
      waiting_reason: "no_progress",
      turns_used: 20,
      no_progress_count: 0,
      last_playbook_revision: 43,
    })
    .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.id, run.id)));
}

describe("a run at its round limit", () => {
  test("without a result it ends as failed under the limit code and frees the task for the next start", async () => {
    const w = await workspace();
    const run = await queuedRun(w, 2);
    for (const round of [1, 2]) {
      script(run.conversation_id, [
        { tool: "ask_user_confirm", args: { question: "Send the weekly report" } },
        { text: `Still looking, round ${round}.` },
      ]);
      expect(await workQueuedTurn()).toBe(true);
    }
    expect(await runRow(w, run.id)).toMatchObject({
      state: "failed",
      failure_code: "turn_limit_reached",
      waiting_reason: null,
      turns_used: 2,
    });
    expect((await runRow(w, run.id)).ended_at).not.toBeNull();
    expect(await queuedJobs(run.id)).toHaveLength(0);
    expect((await auditOf(w.tenant_id, run.id)).map((row) => row.action)).toEqual([
      "task_run.started",
      "task_run.failed",
    ]);
    expect(await resumeTaskRun({ tenant_id: w.tenant_id, task_run_id: run.id }, db)).toMatchObject({
      resumed: false,
      run: { state: "failed" },
    });
    const next = await startTaskRun(
      { tenant_id: w.tenant_id, task_id: run.task_id, trigger: "manual", started_by: w.owner },
      db,
    );
    expect(next.admitted).toBe(true);
  }, 240_000);

  test("with the result written in its last round it hands the result over", async () => {
    const w = await workspace();
    const run = await queuedRun(w, 1);
    script(run.conversation_id, [
      { tool: "update_playbook", args: await parkedResult(w, run) },
      { text: SUMMARY },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "result_ready",
      failure_code: null,
      turns_used: 1,
    });
  }, 180_000);
});

describe("a run an earlier version left waiting at its round limit", () => {
  test("the sweep hands over the result it had written, with no further round", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    await clearQueue();
    await updatePlaybook(
      db,
      { tenant_id: w.tenant_id, conversation_id: run.conversation_id, principal: w.owner },
      await parkedResult(w, run),
    );
    await storedAsStuck(w, run);
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: SWEEP_AT };
    expect(await advanceTaskRun(db, scope)).toBe("observed");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "result_ready",
      waiting_reason: null,
      failure_code: null,
      turns_used: 20,
    });
    expect(await advanceTaskRun(db, scope)).toBe("idle");
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 180_000);

  test("the sweep ends it as failed when nothing was written, and leaves a run below its limit alone", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    await clearQueue();
    await storedAsStuck(w, run);
    const early = new Date((await runRow(w, run.id)).created_at.getTime() + 60_000);
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: early };
    await db
      .update(taskRuns)
      .set({ turns_used: 19 })
      .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.id, run.id)));
    expect(await advanceTaskRun(db, scope)).toBe("idle");
    expect((await runRow(w, run.id)).state).toBe("waiting");
    await db
      .update(taskRuns)
      .set({ turns_used: 20 })
      .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.id, run.id)));
    expect(await advanceTaskRun(db, scope)).toBe("observed");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "failed",
      failure_code: "turn_limit_reached",
      waiting_reason: null,
    });
    expect(await advanceTaskRun(db, scope)).toBe("idle");
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 180_000);
});
