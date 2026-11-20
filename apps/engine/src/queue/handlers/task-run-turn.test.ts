import { describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { readPlaybook } from "../../conversations/public/authoring.ts";
import { answerElicitationAsPerson } from "../../conversations/public/elicitation.ts";
import {
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/public/lifecycle.ts";
import {
  auditLog,
  conversationElicitations,
  conversationMessages,
  conversationTurns,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { withContext } from "../../logging/context.ts";
import { completeTaskRun, rejectTaskRunResult } from "../../tasks/index.ts";
import {
  settleTaskRunResultConfirmation,
  TASK_RUN_CONTINUATION_MESSAGE,
  TASK_RUN_REJECTION_NOTICE,
} from "../../tasks/run-driver.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { TASK_RUN_TURN_QUEUE } from "../queues.ts";
import { enqueueTaskRunTurn, handleTaskRunTurnJob } from "./task-run-turn.ts";
import {
  answerAsPerson,
  auditOf,
  boss,
  clearQueue,
  db,
  deliveredPlan,
  GOAL,
  jobOf,
  ownedTask,
  person,
  queuedJobs,
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

const nextUuid = createDeterministicUuidFactory(0x7a5c07);

useTaskRunQueue("task_run_turn");

async function lastUserMessage(w: Workspace, run: StartedRun): Promise<string> {
  const rows = await db
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
  const content = rows[0]?.content as { text?: string; origin?: string } | undefined;
  expect(content?.origin).toBe("task_run_continuation");
  return content?.text ?? "";
}

describe("task.run-turn drives a run turn by turn", () => {
  test("a manual start works through its turns to a result and a person confirms it", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    expect(await enqueueTaskRunTurn(db, jobOf(w, run))).toBeString();
    expect(await enqueueTaskRunTurn(db, jobOf(w, run))).toBeNull();
    expect(await queuedJobs(run.id)).toHaveLength(1);

    script(run.conversation_id, [{ text: "Looking at the numbers first." }]);
    expect(await workQueuedTurn()).toBe(true);
    const first = await runRow(w, run.id);
    expect(first).toMatchObject({ state: "running", turns_used: 1, last_seen_turn_seq: 1 });
    expect(await queuedJobs(run.id)).toHaveLength(1);

    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: { expected_revision: 1, plan: await deliveredPlan(w, run.conversation_id) },
      },
      { tool: "ask_user_confirm", args: { question: GOAL, destructive: true } },
      { text: "never reached" },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    const ready = await runRow(w, run.id);
    expect(ready).toMatchObject({ state: "result_ready", turns_used: 2, last_seen_turn_seq: 2 });
    expect(await queuedJobs(run.id)).toHaveLength(0);

    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: { expected_revision: 2, plan: await storedPlan(w, run.conversation_id) },
      },
      { text: "Glad it fits." },
    ]);
    await answerAsPerson(w, run.conversation_id, w.owner, { confirmed: true });
    const done = await runRow(w, run.id);
    expect(done).toMatchObject({
      state: "completed",
      completed_by: w.owner.id,
      turns_used: 2,
      last_seen_turn_seq: 3,
    });
    const audit = await auditOf(w.tenant_id, run.id);
    expect(audit.map((row) => row.action)).toEqual([
      "task_run.started",
      "task_run.result_ready",
      "task_run.completed",
    ]);
    expect(new Set(audit.map((row) => row.trace_id))).toEqual(new Set([run.trace_id]));
  }, 180_000);

  test("the background hop keeps the trace of the run and writes as a relayed message", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    await enqueueTaskRunTurn(db, jobOf(w, run));
    script(run.conversation_id, [{ text: "Working." }]);
    expect(await workQueuedTurn()).toBe(true);
    const rows = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata, trace_id: auditLog.trace_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, w.tenant_id), eq(auditLog.resource_id, run.conversation_id)),
      );
    const turnRows = rows.filter((row) => row.action === "conversation.turn_changed");
    expect(turnRows.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(turnRows.map((row) => (row.metadata as { audit_trace_id?: string }).audit_trace_id)),
    ).toEqual(new Set([run.trace_id]));
    expect(new Set(turnRows.map((row) => row.trace_id))).toEqual(new Set([run.trace_id]));
    const [started] = await auditOf(w.tenant_id, run.id);
    expect(started).toMatchObject({
      action: "task_run.started",
      trace_id: run.trace_id,
      metadata: { audit_trace_id: run.trace_id },
    });
    const messages = await db
      .select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, w.tenant_id),
          eq(conversationMessages.conversation_id, run.conversation_id),
          eq(conversationMessages.role, "user"),
        ),
      );
    expect(messages.map((row) => row.content)).toEqual([
      { text: TASK_RUN_CONTINUATION_MESSAGE, origin: "task_run_continuation" },
    ]);
  }, 180_000);

  test("a second enqueue is a no-op while a job waits, while it runs and while a turn is held", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    const job = jobOf(w, run);
    await clearQueue();
    const first = await enqueueTaskRunTurn(db, job);
    expect(first).toBeString();
    const again = await Promise.all([enqueueTaskRunTurn(db, job), enqueueTaskRunTurn(db, job)]);
    expect(again).toEqual([null, null]);
    const [active] = await boss.fetch(TASK_RUN_TURN_QUEUE);
    expect(active?.id).toBe(first as string);
    expect(await enqueueTaskRunTurn(db, job)).toBeNull();
    const held = await registerConversationAbort(w.tenant_id, run.conversation_id, db);
    expect(await enqueueTaskRunTurn(db, job, { except_job_id: first as string })).toBeNull();
    await unregisterConversationAbort(w.tenant_id, run.conversation_id, held);
    await boss.complete(TASK_RUN_TURN_QUEUE, first as string);
    expect(await queuedJobs(run.id)).toHaveLength(0);
    expect(await enqueueTaskRunTurn(db, job)).toBeString();
    expect(await queuedJobs(run.id)).toHaveLength(1);
    expect((await runRow(w, run.id)).state).toBe("running");
  }, 180_000);

  test("a job that finds the conversation busy is dropped without a trace on the run", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    const held = await registerConversationAbort(w.tenant_id, run.conversation_id, db);
    try {
      await handleTaskRunTurnJob(
        { id: nextUuid(), name: TASK_RUN_TURN_QUEUE, data: jobOf(w, run) } as never,
        db,
        boss,
      );
    } finally {
      await unregisterConversationAbort(w.tenant_id, run.conversation_id, held);
    }
    expect(await runRow(w, run.id)).toMatchObject({
      state: "running",
      turns_used: 0,
      failure_code: null,
    });
    expect((await auditOf(w.tenant_id, run.id)).map((row) => row.action)).toEqual([
      "task_run.started",
    ]);
  }, 180_000);

  async function readyRun() {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    await clearQueue();
    await enqueueTaskRunTurn(db, jobOf(w, run));
    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: { expected_revision: 1, plan: await deliveredPlan(w, run.conversation_id) },
      },
      { tool: "ask_user_confirm", args: { question: GOAL, destructive: true } },
    ]);
    await workQueuedTurn();
    expect((await runRow(w, run.id)).state).toBe("result_ready");
    return { w, run };
  }

  test("a person who answers no reopens the run and it continues working", async () => {
    const { w, run } = await readyRun();
    script(run.conversation_id, [{ text: "Understood, I look again." }]);
    await answerAsPerson(w, run.conversation_id, w.owner, { confirmed: false });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "running",
      result_ready_at: null,
      ended_at: null,
      last_seen_turn_seq: 2,
    });
    expect(await queuedJobs(run.id)).toHaveLength(1);
    expect((await auditOf(w.tenant_id, run.id)).map((row) => row.action)).toEqual([
      "task_run.started",
      "task_run.result_ready",
      "task_run.resumed",
    ]);
    script(run.conversation_id, [{ text: "I still think it is done." }]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await lastUserMessage(w, run)).toBe(
      `${TASK_RUN_CONTINUATION_MESSAGE}\n${TASK_RUN_REJECTION_NOTICE}`,
    );
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", no_progress_count: 1 });
    const reworked = await deliveredPlan(w, run.conversation_id);
    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: { expected_revision: 2, plan: { ...reworked, title: "Weekly report, reworked" } },
      },
      { text: "Reworked." },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "result_ready",
      rejected_playbook_revision: null,
    });
  }, 180_000);

  test("an approval-backed question is never answered by a result decision", async () => {
    const w = await workspace();
    const run = await startedRun(w, await ownedTask(w));
    const [question] = await db
      .insert(conversationElicitations)
      .values({
        tenant_id: w.tenant_id,
        conversation_id: run.conversation_id,
        tool_name: "ask_user_confirm",
        summary: "Run 1 held write step(s)",
        input: {
          question: GOAL,
          commit_intent: {
            kind: "commit_held_workflow_writes",
            payload: { tool: "wf_send", approval_id: nextUuid() },
          },
        },
      })
      .returning({ id: conversationElicitations.id });
    expect(
      await settleTaskRunResultConfirmation(db, {
        tenant_id: w.tenant_id,
        task_run_id: run.id,
        principal: w.owner,
        confirmed: true,
      }),
    ).toBe(false);
    expect(
      await answerElicitationAsPerson(db, {
        tenant_id: w.tenant_id,
        conversation_id: run.conversation_id,
        elicitation_id: question?.id ?? "",
        principal: w.owner,
        output: { confirmed: true },
      }),
    ).toBe(false);
    const [still] = await db
      .select({ status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, w.tenant_id),
          eq(conversationElicitations.id, question?.id ?? ""),
        ),
      );
    expect(still?.status).toBe("pending");
    const approvals = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, w.tenant_id), eq(auditLog.action, "approval.approved")));
    expect(approvals).toEqual([]);
  }, 180_000);

  test("an answer relayed over a credential does not confirm the result", async () => {
    const { w, run } = await readyRun();
    script(run.conversation_id, [
      {
        tool: "update_playbook",
        args: { expected_revision: 2, plan: await storedPlan(w, run.conversation_id) },
      },
      { text: "Noted." },
    ]);
    await answerAsPerson(w, run.conversation_id, w.owner, { confirmed: true }, "mcp_oauth");
    expect(await runRow(w, run.id)).toMatchObject({ state: "result_ready", completed_by: null });
  }, 180_000);

  test("a result decided outside the chat answers the open question without a model turn", async () => {
    type Target = { w: Workspace; run: StartedRun };
    const turnsOf = async (target: Target) =>
      (
        await db
          .select({ id: conversationTurns.id })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.tenant_id, target.w.tenant_id),
              eq(conversationTurns.conversation_id, target.run.conversation_id),
            ),
          )
      ).length;
    const decision = async (target: Target) =>
      (
        await db
          .select({
            status: conversationElicitations.status,
            output: conversationElicitations.output,
            decided_by: conversationElicitations.decided_by,
            decided_by_kind: conversationElicitations.decided_by_kind,
          })
          .from(conversationElicitations)
          .where(
            and(
              eq(conversationElicitations.tenant_id, target.w.tenant_id),
              eq(conversationElicitations.conversation_id, target.run.conversation_id),
            ),
          )
      )[0];
    const settle = (target: Target, yes: boolean, principal = target.w.owner) =>
      withContext({ audit_access_type: "browser_session" }, () =>
        settleTaskRunResultConfirmation(db, {
          tenant_id: target.w.tenant_id,
          task_run_id: target.run.id,
          principal,
          confirmed: yes,
        }),
      );

    const confirmed = await readyRun();
    const calls = getMockProvider().calls.length;
    const turns = await turnsOf(confirmed);
    const stranger = await person(confirmed.w.tenant_id, "member");
    expect(await settle(confirmed, true, stranger)).toBe(false);
    expect((await decision(confirmed))?.status).toBe("pending");
    await completeTaskRun(
      {
        tenant_id: confirmed.w.tenant_id,
        principal: confirmed.w.owner,
        task_run_id: confirmed.run.id,
      },
      db,
    );
    expect(await settle(confirmed, true)).toBe(true);
    expect(await settle(confirmed, true)).toBe(false);
    expect(await decision(confirmed)).toMatchObject({
      status: "resolved",
      output: { confirmed: true },
      decided_by: confirmed.w.owner.id,
      decided_by_kind: "user",
    });
    expect((await runRow(confirmed.w, confirmed.run.id)).state).toBe("completed");
    const panel = await readPlaybook(db, {
      tenant_id: confirmed.w.tenant_id,
      conversation_id: confirmed.run.conversation_id,
      principal: confirmed.w.owner,
    });
    expect(panel?.status).toBe("completed");
    expect(panel?.steps.find((step) => step.id === "confirm-result")?.status).toBe("verified");
    expect(await turnsOf(confirmed)).toBe(turns);
    expect(getMockProvider().calls.length).toBe(calls);

    const rejected = await readyRun();
    const before = await turnsOf(rejected);
    const reopened = await rejectTaskRunResult(
      {
        tenant_id: rejected.w.tenant_id,
        principal: rejected.w.owner,
        task_run_id: rejected.run.id,
      },
      db,
    );
    expect(reopened).toMatchObject({ enqueue: true, run: { state: "running" } });
    expect(await settle(rejected, false, rejected.w.admin)).toBe(true);
    expect(await decision(rejected)).toMatchObject({
      status: "resolved",
      output: { confirmed: false },
      decided_by: rejected.w.admin.id,
    });
    expect(await turnsOf(rejected)).toBe(before);
    expect((await runRow(rejected.w, rejected.run.id)).state).toBe("running");
    expect(await enqueueTaskRunTurn(db, jobOf(rejected.w, rejected.run))).toBeString();
    script(rejected.run.conversation_id, [{ text: "I look again." }]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await lastUserMessage(rejected.w, rejected.run)).toContain(TASK_RUN_REJECTION_NOTICE);
    expect(await runRow(rejected.w, rejected.run.id)).toMatchObject({
      state: "running",
      turns_used: 2,
    });
  }, 180_000);
});
