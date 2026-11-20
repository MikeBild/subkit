import { describe, expect, test } from "bun:test";
import { and, asc, desc, eq } from "drizzle-orm";
import { updatePlaybook } from "../../conversations/public/authoring.ts";
import { getTool } from "../../conversations/tools/index.ts";
import { taskRunToolRefusal } from "../../conversations/tools/sdk-wrap/task-run-guard.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createTask, TASK_NO_PROGRESS_LIMIT } from "../../tasks/index.ts";
import { advanceTaskRun, TASK_RUN_LANGUAGE_INSTRUCTIONS } from "../../tasks/run-driver.ts";
import { enqueueTaskRunTurn } from "./task-run-turn.ts";
import {
  answerAsPerson,
  clearQueue,
  db,
  GOAL,
  jobOf,
  leftoverGoalQuestion,
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

useTaskRunQueue("task_run_turn_loop");

const SWEEP_AT = new Date("2027-01-01T00:00:00.000Z");
const SUMMARY = "In Berlin sind es 3,8 °C bei leichtem Wind.";

async function queuedRun(w: Workspace, input = taskInput()): Promise<StartedRun> {
  const run = await startedRun(w, await ownedTask(w, input));
  await clearQueue();
  await enqueueTaskRunTurn(db, jobOf(w, run));
  return run;
}

async function revisionOf(w: Workspace, run: StartedRun): Promise<number> {
  const [row] = await db
    .select({ revision: conversations.playbook_revision })
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, run.conversation_id)),
    );
  if (!row) throw new Error("missing conversation");
  return row.revision;
}

async function planWith(
  w: Workspace,
  run: StartedRun,
  change: {
    result?: string;
    progress?: "waiting_for_input" | "blocked" | "open";
    note?: string;
    confirm?: "blocked";
  },
) {
  const plan = await storedPlan(w, run.conversation_id);
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.criterion.kind === "assessment"
        ? {
            ...step,
            ...(change.progress ? { progress: change.progress } : {}),
            ...(change.note ? { note: change.note } : {}),
            criterion: { ...step.criterion, result: change.result ?? step.criterion.result },
          }
        : change.confirm
          ? { ...step, progress: change.confirm }
          : step,
    ),
  };
}

async function playbookUpdate(
  w: Workspace,
  run: StartedRun,
  change: Parameters<typeof planWith>[2],
) {
  return {
    tool: "update_playbook",
    args: { expected_revision: await revisionOf(w, run), plan: await planWith(w, run, change) },
  };
}

async function elicitationsOf(w: Workspace, run: StartedRun) {
  return await db
    .select({
      tool_name: conversationElicitations.tool_name,
      status: conversationElicitations.status,
      reason: conversationElicitations.decision_reason,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, w.tenant_id),
        eq(conversationElicitations.conversation_id, run.conversation_id),
      ),
    )
    .orderBy(asc(conversationElicitations.created_at));
}

async function toolOutputs(w: Workspace, run: StartedRun, tool: string) {
  const rows = await db
    .select({ output: conversationToolCalls.output })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, w.tenant_id),
        eq(conversationToolCalls.conversation_id, run.conversation_id),
        eq(conversationToolCalls.tool, tool),
      ),
    )
    .orderBy(asc(conversationToolCalls.created_at));
  return rows.map((row) => row.output as { error_code?: string } | null);
}

async function lastDriverMessage(w: Workspace, run: StartedRun) {
  const [row] = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, w.tenant_id),
        eq(conversationMessages.conversation_id, run.conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(desc(conversationMessages.created_at))
    .limit(1);
  return row?.content as { text: string; origin?: string };
}

describe("a written result is the result", () => {
  test("a step left at waiting_for_input with its result written ends the round in result_ready, with no question", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      await playbookUpdate(w, run, { result: SUMMARY, progress: "waiting_for_input" }),
      { text: SUMMARY },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "result_ready",
      waiting_reason: null,
      turns_used: 1,
    });
    expect(await elicitationsOf(w, run)).toEqual([]);
    expect(await queuedJobs(run.id)).toHaveLength(0);
    expect(await workQueuedTurn()).toBe(false);
  }, 180_000);

  test("a step the model marks blocked is not ready, even with a text in its result", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      await playbookUpdate(w, run, { result: "Could not reach the service.", progress: "blocked" }),
      { text: "I could not do it." },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", no_progress_count: 0 });
  }, 180_000);
});

describe("the result is never a question of the model", () => {
  const spellings = [
    GOAL,
    `  ${GOAL.toUpperCase()}?  `,
    `${GOAL.replace(" ", "\n ")} …`,
    `${GOAL}!?.`,
  ];

  test("every ask tool that repeats the goal is refused, in any spelling; another question passes", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    const marker = {
      task_id: run.task_id,
      task_run_id: run.id,
      environment: "dev" as const,
      workflow_ids: [],
      connector_ids: [],
      web_search: false,
    };
    const ctx = { db, tenant_id: w.tenant_id, conversation_id: run.conversation_id } as never;
    for (const name of ["ask_user_confirm", "ask_user_choice", "ask_user_text", "ask_user_form"]) {
      const tool = getTool(name);
      if (!tool) throw new Error(`${name} is not registered`);
      for (const question of spellings)
        expect(await taskRunToolRefusal(tool, marker, ctx, { question })).toMatchObject({
          ok: false,
          error_code: "task_run_result_question_refused",
        });
      for (const question of ["Which list?", `${GOAL} to whom?`, "", 7])
        expect(await taskRunToolRefusal(tool, marker, ctx, { question })).toBeNull();
    }
  }, 120_000);

  test("asking the goal as a confirmation is refused: nobody is asked and the run does not wait for an answer", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      { tool: "ask_user_confirm", args: { question: `${GOAL}?` } },
      { text: "I will not ask that." },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await elicitationsOf(w, run)).toEqual([]);
    expect(await toolOutputs(w, run, "ask_user_confirm")).toMatchObject([
      { error_code: "task_run_result_question_refused" },
    ]);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "running",
      waiting_reason: null,
      no_progress_count: 1,
    });
  }, 180_000);

  test("the round seen live, result written, step parked, goal asked, ends in result_ready with nobody asked", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      await playbookUpdate(w, run, { result: SUMMARY, progress: "waiting_for_input" }),
      { tool: "ask_user_confirm", args: { question: GOAL } },
      { text: SUMMARY },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "result_ready", turns_used: 1 });
    expect(await elicitationsOf(w, run)).toEqual([]);
  }, 180_000);
});

describe("only real progress keeps a run going", () => {
  test("a model that only rewrites notes stops after the idle limit, not at the round limit", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    let rounds = 0;
    for (;;) {
      script(run.conversation_id, [
        { tool: "inspect_playbook", args: {} },
        await playbookUpdate(w, run, { note: `Checked again, round ${rounds + 1}.` }),
        { text: `The playbook is complete at revision ${await revisionOf(w, run)}.` },
      ]);
      if (!(await workQueuedTurn())) break;
      rounds++;
      if (rounds > 5) throw new Error("the run did not stop");
    }
    expect(rounds).toBe(TASK_NO_PROGRESS_LIMIT);
    expect(await revisionOf(w, run)).toBe(1 + TASK_NO_PROGRESS_LIMIT);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "no_progress",
      turns_used: TASK_NO_PROGRESS_LIMIT,
      no_progress_count: TASK_NO_PROGRESS_LIMIT,
      last_playbook_revision: 1 + TASK_NO_PROGRESS_LIMIT,
      progress_marks: [],
    });
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 240_000);

  test("after a person answered, at most the idle limit of rounds follows without progress", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      { tool: "ask_user_confirm", args: { question: "Should the report go to everyone?" } },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "waiting", waiting_reason: "question" });
    script(run.conversation_id, [{ text: "Thanks." }]);
    await answerAsPerson(w, run.conversation_id, w.owner, { confirmed: true });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "running",
      turns_used: 1,
      no_progress_count: 0,
    });
    let rounds = 0;
    for (;;) {
      script(run.conversation_id, [
        await playbookUpdate(w, run, { note: `Human acceptance verified, round ${rounds + 1}.` }),
        { text: "The playbook is complete." },
      ]);
      if (!(await workQueuedTurn())) break;
      rounds++;
      if (rounds > 5) throw new Error("the run did not stop");
    }
    expect(rounds).toBe(TASK_NO_PROGRESS_LIMIT);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "no_progress",
      turns_used: 1 + TASK_NO_PROGRESS_LIMIT,
    });
  }, 240_000);

  test("a bound workflow that ran in the round is progress, a held or failed one is not", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    const ran = async (tool: string, outcome: string) => {
      const [row] = await db
        .insert(conversationToolCalls)
        .values({
          tenant_id: w.tenant_id,
          conversation_id: run.conversation_id,
          tool,
          input: {},
          outcome,
        })
        .returning({ id: conversationToolCalls.id });
      return row?.id;
    };
    const round = async () => {
      script(run.conversation_id, [{ tool: "inspect_playbook", args: {} }, { text: "Done." }]);
      expect(await workQueuedTurn()).toBe(true);
      return await runRow(w, run.id);
    };
    const first = await ran("wf_weather", "ok");
    await ran("wf_weather", "pending");
    await ran("call_connector", "error");
    expect(await round()).toMatchObject({
      state: "running",
      no_progress_count: 0,
      progress_marks: [`call:${first}`],
    });
    const second = await ran("call_connector", "ok");
    expect(await round()).toMatchObject({
      state: "running",
      no_progress_count: 0,
      progress_marks: [`call:${first}`, `call:${second}`],
    });
    expect(await round()).toMatchObject({ state: "running", no_progress_count: 1 });
  }, 240_000);

  test("a new result is progress, the same result written again is not", async () => {
    const w = await workspace();
    const base = taskInput();
    const [first] = base.plan.steps;
    if (!first) throw new Error("missing template step");
    const run = await queuedRun(
      w,
      taskInput({ plan: { ...base.plan, steps: [first, { ...first, id: "send" }] } }),
    );
    const write = async (result: string, note: string) => {
      const plan = await storedPlan(w, run.conversation_id);
      script(run.conversation_id, [
        {
          tool: "update_playbook",
          args: {
            expected_revision: await revisionOf(w, run),
            plan: {
              ...plan,
              steps: plan.steps.map((step) =>
                step.id === "collect" && step.criterion.kind === "assessment"
                  ? { ...step, note, criterion: { ...step.criterion, result } }
                  : step,
              ),
            },
          },
        },
        { text: "Recorded." },
      ]);
      expect(await workQueuedTurn()).toBe(true);
      return await runRow(w, run.id);
    };
    expect(await write("The numbers are collected.", "first")).toMatchObject({
      state: "running",
      no_progress_count: 0,
    });
    expect(await write("The numbers are collected.", "second")).toMatchObject({
      state: "running",
      no_progress_count: 1,
    });
    expect(await write("The numbers are collected and checked.", "third")).toMatchObject({
      state: "running",
      no_progress_count: 0,
    });
    expect(await write("The numbers are collected.", "fourth")).toMatchObject({
      no_progress_count: 1,
    });
    expect(await write("The numbers are collected and checked.", "fifth")).toMatchObject({
      state: "waiting",
      waiting_reason: "no_progress",
      turns_used: 5,
    });
  }, 300_000);
});

describe("a goal question left over from an earlier version", () => {
  test("a yes to it hands the written result over instead of starting another round", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      { tool: "ask_user_confirm", args: { question: "Should the report go to everyone?" } },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    await leftoverGoalQuestion(w, run.conversation_id);
    await updatePlaybook(
      db,
      { tenant_id: w.tenant_id, conversation_id: run.conversation_id, principal: w.owner },
      {
        expected_revision: await revisionOf(w, run),
        plan: await planWith(w, run, {
          result: SUMMARY,
          progress: "waiting_for_input",
          confirm: "blocked",
        }),
      },
    );
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "question",
      turns_used: 1,
    });
    const stored = await storedPlan(w, run.conversation_id);
    expect(stored.steps.map((step) => [step.id, step.progress])).toEqual([
      ["collect", "waiting_for_input"],
      ["confirm-result", "blocked"],
    ]);

    script(run.conversation_id, [
      await playbookUpdate(w, run, { note: "Human acceptance verified." }),
      { text: "The playbook is complete." },
    ]);
    await answerAsPerson(w, run.conversation_id, w.owner, { confirmed: true });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "result_ready",
      waiting_reason: null,
      turns_used: 1,
    });
    expect(await queuedJobs(run.id)).toHaveLength(0);
    expect(await workQueuedTurn()).toBe(false);
    expect(
      await advanceTaskRun(db, { tenant_id: w.tenant_id, task_run_id: run.id, now: SWEEP_AT }),
    ).toBe("idle");
    expect((await runRow(w, run.id)).state).toBe("result_ready");
  }, 240_000);
});

describe("the language of the prompt the driver sends", () => {
  test("a German task is told to write German and to say du, an English task to write English", async () => {
    const w = await workspace();
    for (const locale of ["de", "en"] as const) {
      const task = await createTask(
        { tenant_id: w.tenant_id, principal: w.owner, input: taskInput(), locale },
        db,
      );
      const run = await startedRun(w, task);
      await clearQueue();
      await enqueueTaskRunTurn(db, jobOf(w, run));
      script(run.conversation_id, [{ text: "Working." }]);
      expect(await workQueuedTurn()).toBe(true);
      const sent = await lastDriverMessage(w, run);
      expect(sent.origin).toBe("task_run_continuation");
      expect(sent.text).toEndWith(TASK_RUN_LANGUAGE_INSTRUCTIONS[locale]);
    }
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.de).toContain("in German");
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.de).toContain("„du“");
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.en).toContain("in English");
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.en).not.toContain("German");
  }, 240_000);
});
