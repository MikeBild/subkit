import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createElicitation } from "../../conversations/elicitations.ts";
import { cancelConversation } from "../../conversations/service/lifecycle.ts";
import { conversations } from "../../db/schema/index.ts";
import { continueTaskRunInNewConversation, pauseTask } from "../../tasks/index.ts";
import { enqueueTaskRunTurn } from "./task-run-turn.ts";
import {
  auditOf,
  clearQueue,
  db,
  jobOf,
  ownedTask,
  pendingElicitation,
  runRow,
  type StartedRun,
  script,
  startedRun,
  storedPlan,
  useTaskRunQueue,
  type Workspace,
  workQueuedTurn,
  workspace,
} from "./task-run-turn-fixtures.ts";

useTaskRunQueue("task_run_turn_new_conversation");

async function workedRun(w: Workspace): Promise<StartedRun> {
  const run = await startedRun(w, await ownedTask(w));
  await clearQueue();
  await enqueueTaskRunTurn(db, jobOf(w, run));
  script(run.conversation_id, [{ text: "Collecting the numbers." }]);
  expect(await workQueuedTurn()).toBe(true);
  return run;
}

async function heldRun(): Promise<{ w: Workspace; run: StartedRun }> {
  const w = await workspace();
  const run = await workedRun(w);
  await cancelConversation(w.tenant_id, run.conversation_id, null, db, "system");
  const opening = await createElicitation(
    {
      tenant_id: w.tenant_id,
      conversation_id: run.conversation_id,
      tool_call_id: null,
      tool_name: "ask_user_text",
      summary: "Which report?",
      input: { question: "Which report should I send?" },
      actor_id: null,
      actor_type: "system",
    },
    db,
  );
  expect(opening).toEqual({ ok: false, reason: "conversation_abandoned" });
  return { w, run };
}

async function conversationOf(w: Workspace, conversation_id: string) {
  const [row] = await db
    .select({
      status: conversations.status,
      owner_id: conversations.owner_id,
      task_run_id: sql<
        string | null
      >`${conversations.draft} -> 'session' -> 'task_run' ->> 'task_run_id'`,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, conversation_id)));
  return row;
}

async function runConversationCount(w: Workspace, run: StartedRun): Promise<number> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, w.tenant_id),
        sql`${conversations.draft} -> 'session' -> 'task_run' ->> 'task_run_id' = ${run.id}`,
      ),
    );
  return rows.length;
}

describe("a run held by its abandoned conversation continues in a new one", () => {
  test("the owner moves the run to a new conversation where it asks again", async () => {
    const { w, run } = await heldRun();
    const before = await runRow(w, run.id);
    expect(before).toMatchObject({
      state: "waiting",
      waiting_reason: "conversation_abandoned",
      turns_used: 1,
      last_seen_turn_seq: 1,
    });

    const outcome = await continueTaskRunInNewConversation(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id, source: "api" },
      db,
    );

    if (!outcome.continued) throw new Error(`not continued: ${outcome.reason}`);
    const moved = outcome.run.conversation_id;
    if (!moved) throw new Error("the run has no conversation");
    expect(moved).not.toBe(run.conversation_id);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "running",
      waiting_reason: null,
      conversation_id: moved,
      turns_used: 1,
      last_seen_turn_id: null,
      last_seen_turn_seq: 0,
      rejected_playbook_revision: null,
      failure_code: null,
    });
    expect(await conversationOf(w, moved)).toMatchObject({
      status: "active",
      owner_id: w.owner.id,
      task_run_id: run.id,
    });
    expect(await conversationOf(w, run.conversation_id)).toMatchObject({ status: "abandoned" });
    expect((await storedPlan(w, moved)).steps.map((step) => step.id)).toEqual(
      (await storedPlan(w, run.conversation_id)).steps.map((step) => step.id),
    );
    const resumed = (await auditOf(w.tenant_id, run.id)).at(-1);
    expect(resumed).toMatchObject({
      action: "task_run.resumed",
      result: "success",
      metadata: {
        previous_state: "waiting",
        resume_reason: "conversation_abandoned",
        previous_conversation_id: run.conversation_id,
        conversation_id: moved,
        request_source: "api",
      },
    });

    await enqueueTaskRunTurn(db, jobOf(w, run));
    script(moved, [
      { tool: "ask_user_text", args: { question: "Which report should I send?" } },
      { text: "never reached" },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "question",
      conversation_id: moved,
      turns_used: 2,
      last_seen_turn_seq: 1,
    });
    expect((await pendingElicitation(w, moved)).tool_name).toBe("ask_user_text");
  }, 180_000);

  test("anyone but the owner is refused and nothing is opened", async () => {
    const { w, run } = await heldRun();

    const outcome = await continueTaskRunInNewConversation(
      { tenant_id: w.tenant_id, principal: w.admin, task_run_id: run.id },
      db,
    );

    expect(outcome).toEqual({ continued: false, reason: "not_owner" });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "conversation_abandoned",
      conversation_id: run.conversation_id,
    });
    expect(await runConversationCount(w, run)).toBe(1);
  }, 180_000);

  test("a run that is not held, or already moved, is refused without a new conversation", async () => {
    const w = await workspace();
    const running = await workedRun(w);
    expect(
      await continueTaskRunInNewConversation(
        { tenant_id: w.tenant_id, principal: w.owner, task_run_id: running.id },
        db,
      ),
    ).toEqual({ continued: false, reason: "not_held" });
    expect(await runConversationCount(w, running)).toBe(1);

    const held = await heldRun();
    const ref = { tenant_id: held.w.tenant_id, principal: held.w.owner, task_run_id: held.run.id };
    expect((await continueTaskRunInNewConversation(ref, db)).continued).toBe(true);
    expect(await continueTaskRunInNewConversation(ref, db)).toEqual({
      continued: false,
      reason: "not_held",
    });
    expect(await runConversationCount(held.w, held.run)).toBe(2);
  }, 180_000);

  test("a paused task keeps the run held until the owner resumes the task", async () => {
    const { w, run } = await heldRun();
    await pauseTask({ tenant_id: w.tenant_id, principal: w.owner, task_id: run.task_id }, db);

    expect(
      await continueTaskRunInNewConversation(
        { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id },
        db,
      ),
    ).toEqual({ continued: false, reason: "paused" });
    expect(await runConversationCount(w, run)).toBe(1);
  }, 180_000);

  test("a run past its deadline ends instead of moving", async () => {
    const { w, run } = await heldRun();
    const { deadline_at } = await runRow(w, run.id);

    const outcome = await continueTaskRunInNewConversation(
      { tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id },
      db,
      { now: () => new Date(deadline_at.getTime() + 60_000) },
    );

    expect(outcome).toMatchObject({
      continued: false,
      reason: "run_ended",
      run: { state: "failed", failure_code: "deadline_exceeded" },
    });
    expect(await runConversationCount(w, run)).toBe(1);
  }, 180_000);
});
