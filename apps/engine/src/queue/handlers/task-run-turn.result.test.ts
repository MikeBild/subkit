import { describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { cancelOpenTaskRunQuestions } from "../../conversations/public/elicitation.ts";
import { getTool } from "../../conversations/tools/index.ts";
import { taskRunToolRefusal } from "../../conversations/tools/sdk-wrap/task-run-guard.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
  executions,
  llmUsage,
  tasks,
  tenants,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { currentMonthBucket } from "../../llm/accounting/index.ts";
import { createTask, updateTask } from "../../tasks/index.ts";
import { advanceTaskRun } from "../../tasks/run-driver.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { now } from "../../utils/clock.ts";
import { enqueueTaskRunTurn } from "./task-run-turn.ts";
import {
  auditOf,
  clearQueue,
  db,
  deliveredPlan,
  GOAL,
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

const nextUuid = createDeterministicUuidFactory(0x7a5c09);

useTaskRunQueue("task_run_turn_result");

let sequence = 0;

async function readingWorkflow(w: Workspace): Promise<{ id: string; slug: string }> {
  const slug = `read-weather-${++sequence}`;
  const [workflow] = await db
    .insert(workflows)
    .values({ tenant_id: w.tenant_id, slug, name: slug, lifecycle: "active", is_tool: false })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const [version] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: w.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        steps: [
          {
            id: "shape",
            kind: "transform",
            expression: "return { temperature: 6.4, wind: 12.7 };",
            language: "javascript",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("missing version");
  await db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, w.tenant_id), eq(workflows.id, workflow.id)));
  return { id: workflow.id, slug };
}

function weatherTask(workflow_id: string) {
  const base = taskInput();
  const [summary] = base.plan.steps;
  if (!summary) throw new Error("missing template step");
  return taskInput({
    plan: {
      ...base.plan,
      steps: [
        {
          ...summary,
          id: "fetch",
          label: "Fetch the weather",
          criterion: {
            kind: "execution_succeeded",
            workflow_id,
            environment: "dev",
            after: "2026-01-01T00:00:00.000Z",
          },
        },
        { ...summary, id: "summary", depends_on: ["fetch"] },
      ],
    },
    bindings: {
      workflow_ids: [workflow_id],
      connector_ids: [],
      skill_slugs: [],
      web_search: false,
    },
  });
}

async function elicitationsOf(w: Workspace, run: StartedRun) {
  return await db
    .select({
      tool_name: conversationElicitations.tool_name,
      status: conversationElicitations.status,
      reason: conversationElicitations.decision_reason,
      input: conversationElicitations.input,
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

async function queuedRun(w: Workspace, input = taskInput()): Promise<StartedRun> {
  const run = await startedRun(w, await ownedTask(w, input));
  await clearQueue();
  await enqueueTaskRunTurn(db, jobOf(w, run));
  return run;
}

describe("a run with a bound workflow that only reads", () => {
  test("running it, recording the execution and delivering the assessment ends in result_ready without a question", async () => {
    const w = await workspace();
    const workflow = await readingWorkflow(w);
    const run = await queuedRun(w, weatherTask(workflow.id));

    const started = await storedPlan(w, run.conversation_id);
    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: {
          expected_revision: 1,
          plan: {
            ...started,
            steps: started.steps.map((step) =>
              step.id === "fetch" ? { ...step, note: "Fetching the weather." } : step,
            ),
          },
        },
      },
      { tool: `wf_${workflow.slug}`, args: {} },
      { text: "The weather is fetched." },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    const [execution] = await db
      .select({ id: executions.id, hold_writes: executions.hold_writes, status: executions.status })
      .from(executions)
      .where(and(eq(executions.tenant_id, w.tenant_id), eq(executions.workflow_id, workflow.id)));
    expect(execution).toMatchObject({ hold_writes: true, status: "succeeded" });
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", turns_used: 1 });

    script(run.conversation_id, [
      { tool: "get_execution", args: { id: execution?.id } },
      { text: "The execution succeeded." },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", turns_used: 2 });
    const [read] = await db
      .select({ id: conversationToolCalls.id })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, w.tenant_id),
          eq(conversationToolCalls.conversation_id, run.conversation_id),
          eq(conversationToolCalls.tool, "get_execution"),
        ),
      );
    if (!read) throw new Error("get_execution was not recorded");

    const fetched = await storedPlan(w, run.conversation_id);
    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: {
          expected_revision: 2,
          plan: {
            ...fetched,
            steps: fetched.steps.map((step) =>
              step.id === "fetch"
                ? { ...step, evidence_ids: [read.id] }
                : step.criterion.kind === "assessment"
                  ? { ...step, criterion: { ...step.criterion, result: "6.4 °C, wind 12.7 km/h." } }
                  : step,
            ),
          },
        },
      },
      { text: "It is 6.4 °C in Berlin. The wind blows at 12.7 km/h." },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "result_ready",
      waiting_reason: null,
      turns_used: 3,
    });
    expect(await elicitationsOf(w, run)).toEqual([]);
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 240_000);
});

describe("questions inside a background turn", () => {
  test("a plain confirmation question leaves the run waiting for the answer", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      { tool: "ask_user_confirm", args: { question: "Should the report go to everyone?" } },
      { text: "never reached" },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "question",
      turns_used: 1,
    });
    expect(await elicitationsOf(w, run)).toMatchObject([
      { tool_name: "ask_user_confirm", status: "pending" },
    ]);
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 180_000);

  test("a question bound to the result step is refused and nobody is asked", async () => {
    const w = await workspace();
    const marker = {
      task_id: nextUuid(),
      task_run_id: nextUuid(),
      environment: "dev" as const,
      workflow_ids: [],
      connector_ids: [],
      web_search: false,
    };
    const ctx = { db, tenant_id: w.tenant_id } as never;
    for (const name of ["ask_user_choice", "ask_user_confirm", "ask_user_text"]) {
      const tool = getTool(name);
      if (!tool) throw new Error(`${name} is not registered`);
      expect(
        await taskRunToolRefusal(tool, marker, ctx, {
          question: "Is this summary right?",
          playbook_step_id: "confirm-result",
        }),
      ).toMatchObject({ ok: false, error_code: "task_run_result_question_refused" });
      expect(
        await taskRunToolRefusal(tool, marker, ctx, {
          question: "Which list?",
          playbook_step_id: "collect",
        }),
      ).toBeNull();
    }

    const run = await queuedRun(w);
    script(run.conversation_id, [
      {
        tool: "ask_user_choice",
        args: {
          question: "Is this summary right?",
          playbook_step_id: "confirm-result",
          options: [
            { value: "confirmed", label: "Yes" },
            { value: "revise", label: "No" },
          ],
        },
      },
      { text: "The summary stands as written." },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await elicitationsOf(w, run)).toEqual([]);
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", waiting_reason: null });
  }, 180_000);

  test("a question asked next to a finished result is withdrawn when the result is offered", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: { expected_revision: 1, plan: await deliveredPlan(w, run.conversation_id) },
      },
      { tool: "ask_user_confirm", args: { question: "Is this summary right?" } },
      { text: "never reached" },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "result_ready", waiting_reason: null });
    expect(await elicitationsOf(w, run)).toMatchObject([
      { tool_name: "ask_user_confirm", status: "cancelled", reason: "task_run_result_ready" },
    ]);
    const [asked] = await db
      .select({ output: conversationToolCalls.output, outcome: conversationToolCalls.outcome })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, w.tenant_id),
          eq(conversationToolCalls.conversation_id, run.conversation_id),
          eq(conversationToolCalls.tool, "ask_user_confirm"),
        ),
      );
    expect(asked).toMatchObject({
      outcome: "denied",
      output: { ok: false, abandoned: true, reason: "task_run_result_ready" },
    });
  }, 180_000);

  test("an offered result keeps open approvals only, also not a question that repeats the goal; an ended run keeps nothing", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    const ask = async (tool_name: string, input: Record<string, unknown>) => {
      await db.insert(conversationElicitations).values({
        tenant_id: w.tenant_id,
        conversation_id: run.conversation_id,
        tool_name,
        summary: "question",
        input,
        status: "pending",
      });
    };
    await ask("ask_user_confirm", { question: GOAL });
    await ask("ask_user_confirm", {
      question: "Perform the held writes?",
      commit_intent: { kind: "commit_held_workflow_writes", payload: {} },
    });
    await ask("ask_user_text", { question: "Which list?" });
    const scope = { tenant_id: w.tenant_id, conversation_id: run.conversation_id };
    expect(await cancelOpenTaskRunQuestions(db, { ...scope, outcome: "result_ready" })).toBe(2);
    expect((await elicitationsOf(w, run)).map((row) => [row.tool_name, row.status])).toEqual([
      ["ask_user_confirm", "cancelled"],
      ["ask_user_confirm", "pending"],
      ["ask_user_text", "cancelled"],
    ]);
    expect(await cancelOpenTaskRunQuestions(db, { ...scope, outcome: "ended" })).toBe(1);
    expect((await elicitationsOf(w, run)).map((row) => row.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  }, 120_000);
});

describe("the language of a run", () => {
  async function handoffText(w: Workspace, run: StartedRun): Promise<string | undefined> {
    script(run.conversation_id, [
      {
        tool: "ask_user_choice",
        args: {
          question: "Which list?",
          options: [
            { value: "all", label: "All" },
            { value: "team", label: "Team" },
          ],
        },
      },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    const rows = await db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, w.tenant_id),
          eq(conversationMessages.conversation_id, run.conversation_id),
          eq(conversationMessages.role, "assistant"),
        ),
      );
    return rows
      .map((row) => row.content as { text?: string; _reason?: string })
      .find((content) => content._reason === "handoff_summary")?.text;
  }

  test("background turns write in the language the owner last used, not in the language of the engine's own message", async () => {
    const w = await workspace();
    const input = taskInput();
    const german = await createTask(
      { tenant_id: w.tenant_id, principal: w.owner, input, locale: "de" },
      db,
    );
    const stored = async (id: string) => {
      const [row] = await db
        .select({ locale: tasks.locale, fingerprint: tasks.fingerprint })
        .from(tasks)
        .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, id)));
      return row;
    };
    expect(await stored(german.id)).toEqual({ locale: "de", fingerprint: german.fingerprint });
    const germanRun = await startedRun(w, german);
    await clearQueue();
    await enqueueTaskRunTurn(db, jobOf(w, germanRun));
    expect(await handoffText(w, germanRun)).toStartWith(
      "Hier fehlt noch eine Entscheidung von dir.",
    );

    const english = await createTask(
      { tenant_id: w.tenant_id, principal: w.owner, input, locale: "en" },
      db,
    );
    expect(english.fingerprint).toBe(german.fingerprint);
    const englishRun = await startedRun(w, english);
    await clearQueue();
    await enqueueTaskRunTurn(db, jobOf(w, englishRun));
    expect(await handoffText(w, englishRun)).toStartWith("A decision from you is still missing.");
  }, 240_000);

  test("an update by the owner moves the language without touching the fingerprint; an admin's update and a missing language keep it", async () => {
    const w = await workspace();
    const input = taskInput();
    const task = await createTask(
      { locale: "de", tenant_id: w.tenant_id, principal: w.owner, input },
      db,
    );
    const locale = async () => {
      const [row] = await db
        .select({ locale: tasks.locale })
        .from(tasks)
        .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
      return row?.locale;
    };
    expect(await locale()).toBe("de");
    const update = (principal: Workspace["owner"], expected_revision: number, to?: "de" | "en") =>
      updateTask(
        {
          tenant_id: w.tenant_id,
          principal,
          task_id: task.id,
          input: { ...input, expected_revision },
          ...(to ? { locale: to } : {}),
        },
        db,
      );
    const moved = await update(w.owner, 1, "en");
    expect(moved).toMatchObject({ grant_invalidated: false, aborted_run_id: null });
    expect(moved.task.fingerprint).toBe(task.fingerprint);
    expect(await locale()).toBe("en");
    await update(w.admin, 2, "de");
    expect(await locale()).toBe("en");
    await update(w.owner, 3);
    expect(await locale()).toBe("en");
    const foreign = async () => {
      await db
        .update(tasks)
        .set({ locale: "fr" as never })
        .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    };
    await expect(foreign()).rejects.toThrow();
  }, 120_000);
});

const SWEEP_AT = new Date("2027-01-01T00:00:00.000Z");

describe("a run that waits for the AI budget", () => {
  test("it is resumed only once the budget allows it again, and writes nothing while it does not", async () => {
    const w = await workspace();
    const run = await queuedRun(w);
    const limit = async (spend_limit_usd: number) => {
      await db.update(tenants).set({ spend_limit_usd }).where(eq(tenants.id, w.tenant_id));
    };
    const at = new Date(now());
    await db.insert(llmUsage).values({
      tenant_id: w.tenant_id,
      flow: "converse",
      model: "claude-sonnet-4-5",
      completion_tokens: 1_000_000,
      total_tokens: 1_000_000,
      result: "success",
      month_bucket: currentMonthBucket(at),
      created_at: at,
    });
    await limit(1);
    script(run.conversation_id, [{ text: "never reached" }]);
    expect(await workQueuedTurn()).toBe(true);
    const waiting = await runRow(w, run.id);
    expect(waiting).toMatchObject({ state: "waiting", waiting_reason: "budget", turns_used: 0 });

    const scope = { tenant_id: w.tenant_id, task_run_id: run.id };
    const trail = async () => (await auditOf(w.tenant_id, run.id)).map((row) => row.action);
    const before = await trail();
    expect(before).toEqual(["task_run.started", "task_run.waiting"]);
    for (const minutes of [1, 2, 30])
      expect(
        await advanceTaskRun(db, {
          ...scope,
          now: new Date(SWEEP_AT.getTime() + minutes * 60_000),
        }),
      ).toBe("idle");
    expect(await trail()).toEqual(before);
    expect(await queuedJobs(run.id)).toHaveLength(0);

    await limit(200);
    expect(await advanceTaskRun(db, { ...scope, now: SWEEP_AT })).toBe("resumed");
    expect(await trail()).toEqual([...before, "task_run.resumed"]);
    expect(await queuedJobs(run.id)).toHaveLength(1);
    script(run.conversation_id, [{ text: "Working again." }]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", turns_used: 1 });
    expect(await trail()).toEqual([...before, "task_run.resumed"]);
  }, 240_000);
});
