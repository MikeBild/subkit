import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationTurns,
  roles,
  tasks,
  users,
} from "../../db/schema/index.ts";
import { createUser, deactivateUser } from "../../identity/provisioning.ts";
import { LlmProviderError, LlmSpendLimitReached } from "../../llm/errors.ts";
import { abortTaskRun, loadTaskOwner, pauseTask, resumeTask } from "../../tasks/index.ts";
import {
  advanceTaskRun,
  observeTaskRun,
  TASK_RUN_CONTINUATION_MESSAGE,
} from "../../tasks/run-driver.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { TASK_RUN_TURN_DLQ, TASK_RUN_TURN_QUEUE } from "../queues.ts";
import { enqueueTaskRunTurn, handleTaskRunTurnJob } from "./task-run-turn.ts";
import { handleTaskRunTurnDeadLetter } from "./task-run-turn-dlq.ts";
import {
  answerAsPerson,
  auditOf,
  boss,
  clearQueue,
  db,
  jobOf,
  ownedTask,
  queuedJobs,
  runRow,
  type StartedRun,
  script,
  startedRun,
  useTaskRunQueue,
  type Workspace,
  workQueuedTurn,
  workspace,
} from "./task-run-turn-fixtures.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c06);

useTaskRunQueue("task_run_turn_states");

async function freshRun(): Promise<{ w: Workspace; run: StartedRun }> {
  const w = await workspace();
  const run = await startedRun(w, await ownedTask(w));
  await clearQueue();
  await enqueueTaskRunTurn(db, jobOf(w, run));
  return { w, run };
}

function jobFor(w: Workspace, run: StartedRun, queue = TASK_RUN_TURN_QUEUE) {
  return { id: nextUuid(), name: queue, data: jobOf(w, run) } as never;
}

// allow-wall-clock: offsets are compared with instants the run driver stamps from the real clock
const later = (ms: number) => new Date(Date.now() + ms);
const FIXED_NOW = new Date(FROZEN_NOW);

describe("task.run-turn maps what happens in a turn to the run", () => {
  test("a question waits, the answer continues the run", async () => {
    const { w, run } = await freshRun();
    script(run.conversation_id, [
      { tool: "ask_user_confirm", args: { question: "Send it to everyone?", destructive: true } },
      { text: "never reached" },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "question",
      turns_used: 1,
    });
    expect(await queuedJobs(run.id)).toHaveLength(0);
    await handleTaskRunTurnJob(jobFor(w, run), db, boss);
    expect((await runRow(w, run.id)).turns_used).toBe(1);

    script(run.conversation_id, [{ text: "Thanks, continuing." }]);
    await answerAsPerson(w, run.conversation_id, w.owner, { confirmed: true });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "running",
      waiting_reason: null,
      turns_used: 1,
      no_progress_count: 0,
      last_seen_turn_seq: 2,
    });
    expect(await queuedJobs(run.id)).toHaveLength(1);
    expect((await auditOf(w.tenant_id, run.id)).map((row) => row.action)).toEqual([
      "task_run.started",
      "task_run.waiting",
      "task_run.resumed",
    ]);
  }, 180_000);

  test("an expired question keeps waiting under its own reason", async () => {
    const { w, run } = await freshRun();
    script(run.conversation_id, [
      { tool: "ask_user_confirm", args: { question: "Send it to everyone?", destructive: true } },
    ]);
    await workQueuedTurn();
    await db
      .update(conversationElicitations)
      .set({ status: "timeout", updated_at: later(1_000) })
      .where(
        and(
          eq(conversationElicitations.tenant_id, w.tenant_id),
          eq(conversationElicitations.conversation_id, run.conversation_id),
        ),
      );
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: FIXED_NOW };
    expect(await advanceTaskRun(db, scope)).toBe("observed");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "question_expired",
    });
    expect(await advanceTaskRun(db, scope)).toBe("idle");
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 180_000);

  test("a requested check sleeps and the sweep wakes the run when it is due", async () => {
    const { w, run } = await freshRun();
    script(run.conversation_id, [
      { tool: "schedule_task_check", args: { in_minutes: 30, reason: "wait for the export" } },
    ]);
    await workQueuedTurn();
    const sleeping = await runRow(w, run.id);
    expect(sleeping).toMatchObject({ state: "sleeping", sleep_reason: "check_requested" });
    expect(sleeping.next_check_at?.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000); // allow-wall-clock: the check is scheduled from the real clock
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id };
    expect(await advanceTaskRun(db, { ...scope, now: later(10 * 60_000) })).toBe("idle");
    expect(await advanceTaskRun(db, { ...scope, now: later(31 * 60_000) })).toBe("resumed");
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", next_check_at: null });
    expect(await queuedJobs(run.id)).toHaveLength(1);
    script(run.conversation_id, [{ text: "The export is there." }]);
    await workQueuedTurn();
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", turns_used: 2 });
  }, 180_000);

  test("provider throttling sleeps, an exhausted budget and missing AI access wait", async () => {
    const throttled = await freshRun();
    const retry_at = later(20 * 60_000);
    expect(
      await workQueuedTurn({
        runTurn: async () => {
          throw new LlmProviderError("rate_limit", "slow down", {
            retry_at: retry_at.toISOString(),
          });
        },
      }),
    ).toBe(true);
    const slept = await runRow(throttled.w, throttled.run.id);
    expect(slept).toMatchObject({ state: "sleeping", sleep_reason: "provider_throttled" });
    expect(slept.next_check_at?.toISOString()).toBe(retry_at.toISOString());
    const [parked] = await db
      .select({ state: conversationTurns.state })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.tenant_id, throttled.w.tenant_id),
          eq(conversationTurns.conversation_id, throttled.run.conversation_id),
        ),
      );
    expect(parked?.state).toBe("failed");

    const broke = await freshRun();
    await workQueuedTurn({
      runTurn: async () => {
        throw new LlmSpendLimitReached();
      },
    });
    expect(await runRow(broke.w, broke.run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "budget",
      turns_used: 0,
    });

    const keyless = await freshRun();
    const service = { aiAccessConfigured: async () => false };
    await workQueuedTurn({ service });
    expect(await runRow(keyless.w, keyless.run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "ai_access",
      turns_used: 0,
    });
    const scope = { tenant_id: keyless.w.tenant_id, task_run_id: keyless.run.id, now: FIXED_NOW };
    expect(await advanceTaskRun(db, scope, service)).toBe("idle");
    expect(await advanceTaskRun(db, scope)).toBe("resumed");
    expect((await runRow(keyless.w, keyless.run.id)).state).toBe("running");

    const failing = await freshRun();
    await workQueuedTurn({
      runTurn: async () => {
        throw new Error("boom");
      },
    });
    expect(await runRow(failing.w, failing.run.id)).toMatchObject({
      state: "failed",
      failure_code: "turn_failed",
    });
  }, 180_000);

  test("an orphaned turn fails the run, and an older turn delivered again is not counted", async () => {
    const { w, run } = await freshRun();
    script(run.conversation_id, [{ text: "Working." }]);
    await workQueuedTurn();
    await clearQueue();
    const seen = await runRow(w, run.id);
    expect(seen).toMatchObject({ state: "running", turns_used: 1, last_seen_turn_seq: 1 });
    const [orphan] = await db
      .insert(conversationTurns)
      .values({
        tenant_id: w.tenant_id,
        conversation_id: run.conversation_id,
        state: "running",
        worker_id: nextUuid(),
        attempt_id: nextUuid(),
      })
      .returning({ id: conversationTurns.id });
    await db.insert(conversationMessages).values({
      tenant_id: w.tenant_id,
      conversation_id: run.conversation_id,
      role: "user",
      content: { text: TASK_RUN_CONTINUATION_MESSAGE, origin: "task_run_continuation" },
    });
    const redelivered = await observeTaskRun(db, {
      tenant_id: w.tenant_id,
      task_run_id: run.id,
      turn: {
        id: seen.last_seen_turn_id,
        driver: "task",
        failure: { code: "internal", retry_at: null },
        interrupted: false,
      },
      source: "queue",
    });
    expect(redelivered).toMatchObject({ changed: false });
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", turns_used: 1 });

    expect(
      await advanceTaskRun(db, { tenant_id: w.tenant_id, task_run_id: run.id, now: FIXED_NOW }),
    ).toBe("observed");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "failed",
      failure_code: "turn_interrupted",
      last_seen_turn_id: orphan?.id,
      last_seen_turn_seq: 2,
    });
    const stale = await observeTaskRun(db, {
      tenant_id: w.tenant_id,
      task_run_id: run.id,
      turn: { id: seen.last_seen_turn_id, driver: "task", failure: null, interrupted: false },
      source: "queue",
    });
    expect(stale?.run).toMatchObject({ state: "failed", turns_used: 2 });
  }, 180_000);

  test("a running run without a turn or a job is repaired, also from the dead-letter queue", async () => {
    const { w, run } = await freshRun();
    await clearQueue();
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: FIXED_NOW };
    expect(await advanceTaskRun(db, scope)).toBe("enqueued");
    expect(await advanceTaskRun(db, scope)).toBe("enqueued");
    expect(await queuedJobs(run.id)).toHaveLength(1);
    await clearQueue();
    for (const failures of [1, 2]) {
      await handleTaskRunTurnDeadLetter(jobFor(w, run, TASK_RUN_TURN_DLQ as never), db);
      expect(await runRow(w, run.id)).toMatchObject({
        state: "running",
        failure_code: null,
        turn_job_failures: failures,
      });
      expect(await queuedJobs(run.id)).toHaveLength(0);
      expect(await advanceTaskRun(db, scope)).toBe("enqueued");
      await clearQueue();
    }
    await handleTaskRunTurnDeadLetter(
      { id: nextUuid(), name: TASK_RUN_TURN_DLQ, data: { tenant_id: "x" } } as never,
      db,
    );
    await handleTaskRunTurnDeadLetter(
      {
        id: nextUuid(),
        name: TASK_RUN_TURN_DLQ,
        data: { ...jobOf(w, run), task_id: nextUuid() },
      } as never,
      db,
    );
    await handleTaskRunTurnJob(
      {
        id: nextUuid(),
        name: TASK_RUN_TURN_QUEUE,
        data: { tenant_id: w.tenant_id },
      } as never,
      db,
      boss,
    );
    expect((await runRow(w, run.id)).state).toBe("running");
    await handleTaskRunTurnDeadLetter(jobFor(w, run, TASK_RUN_TURN_DLQ as never), db);
    expect((await runRow(w, run.id)).turn_job_failures).toBe(3);
    expect(await advanceTaskRun(db, scope)).toBe("observed");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "failed",
      failure_code: "turn_interrupted",
    });
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 180_000);

  test("a turn that worked resets the count of failed jobs", async () => {
    const { w, run } = await freshRun();
    await clearQueue();
    await handleTaskRunTurnDeadLetter(jobFor(w, run, TASK_RUN_TURN_DLQ as never), db);
    expect((await runRow(w, run.id)).turn_job_failures).toBe(1);
    await enqueueTaskRunTurn(db, jobOf(w, run));
    script(run.conversation_id, [{ text: "Working." }]);
    await workQueuedTurn();
    expect(await runRow(w, run.id)).toMatchObject({ turns_used: 1, turn_job_failures: 0 });
  }, 180_000);

  test("a turn that was recorded survives a failing tail: the sweep continues the run", async () => {
    const { w, run } = await freshRun();
    script(run.conversation_id, [{ text: "Working." }]);
    expect(
      await workQueuedTurn({
        service: {
          enqueueRunTurn: async () => {
            throw new Error("queue is down");
          },
        },
      }),
    ).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", turns_used: 1 });
    expect(await queuedJobs(run.id)).toHaveLength(0);
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: FIXED_NOW };
    expect(await advanceTaskRun(db, scope)).toBe("enqueued");
    expect(await queuedJobs(run.id)).toHaveLength(1);
  }, 180_000);

  test("a question asked while the job was starting is seen before the turn runs", async () => {
    const { w, run } = await freshRun();
    let loads = 0;
    let turns = 0;
    await workQueuedTurn({
      runTurn: async () => {
        turns++;
        return {} as never;
      },
      service: {
        loadOwner: async (exec, tenant_id, owner_id) => {
          loads++;
          if (loads === 3)
            await db.insert(conversationElicitations).values({
              tenant_id: w.tenant_id,
              conversation_id: run.conversation_id,
              tool_name: "ask_user_text",
              summary: "Which list?",
              input: { question: "Which list?" },
            });
          return await loadTaskOwner(exec, tenant_id, owner_id);
        },
      },
    });
    expect(turns).toBe(0);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "question",
      turns_used: 0,
    });
  }, 180_000);

  test("a waiting run continues once the budget allows again", async () => {
    const { w, run } = await freshRun();
    await workQueuedTurn({
      runTurn: async () => {
        throw new LlmSpendLimitReached();
      },
    });
    expect((await runRow(w, run.id)).waiting_reason).toBe("budget");
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: FIXED_NOW };
    expect(await advanceTaskRun(db, scope, { llmBudgetAvailable: async () => false })).toBe("idle");
    expect(await advanceTaskRun(db, scope)).toBe("resumed");
    expect((await runRow(w, run.id)).state).toBe("running");
    expect(await queuedJobs(run.id)).toHaveLength(1);
  }, 180_000);

  test("an owner who may no longer run tasks ends this run only", async () => {
    const { w, run } = await freshRun();
    const [enduser] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.tenant_id), eq(roles.name, "enduser")));
    await db
      .update(users)
      .set({ role_id: enduser?.id ?? "" })
      .where(and(eq(users.tenant_id, w.tenant_id), eq(users.id, w.owner.id)));
    let turns = 0;
    await workQueuedTurn({
      runTurn: async () => {
        turns++;
        return {} as never;
      },
    });
    expect(turns).toBe(0);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "aborted",
      failure_code: "owner_unavailable",
    });
    const [task] = await db
      .select({ paused_at: tasks.paused_at })
      .from(tasks)
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, run.task_id)));
    expect(task?.paused_at).toBeNull();
  }, 180_000);

  test("a deleted conversation fails the run", async () => {
    const { w, run } = await freshRun();
    await db
      .update(conversations)
      .set({ status: "abandoned" })
      .where(
        and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, run.conversation_id)),
      );
    await workQueuedTurn();
    expect(await runRow(w, run.id)).toMatchObject({
      state: "failed",
      failure_code: "conversation_closed",
    });

    const gone = await freshRun();
    await db
      .delete(conversations)
      .where(
        and(
          eq(conversations.tenant_id, gone.w.tenant_id),
          eq(conversations.id, gone.run.conversation_id),
        ),
      );
    await workQueuedTurn();
    expect(await runRow(gone.w, gone.run.id)).toMatchObject({
      state: "failed",
      failure_code: "conversation_closed",
      conversation_id: null,
    });
  }, 180_000);

  test("pause holds the run, resume continues it, abort ends it", async () => {
    const { w, run } = await freshRun();
    const ref = { tenant_id: w.tenant_id, principal: w.owner, task_id: run.task_id };
    await pauseTask(ref, db);
    expect(await runRow(w, run.id)).toMatchObject({ state: "sleeping", sleep_reason: "paused" });
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "sleeping", turns_used: 0 });
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: later(86_400_000) };
    expect(await advanceTaskRun(db, scope)).toBe("idle");
    const resumed = await resumeTask(ref, db);
    expect(resumed).toMatchObject({ enqueue: true, run: { state: "running" } });
    expect(await queuedJobs(run.id)).toHaveLength(1);
    await resumeTask(ref, db);
    expect(await queuedJobs(run.id)).toHaveLength(1);

    await abortTaskRun({ tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id }, db);
    expect(await workQueuedTurn()).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({ state: "aborted", turns_used: 0 });
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 180_000);

  test("removing the owner pauses the tasks and ends the run; inviting again does not resume", async () => {
    const { w, run } = await freshRun();
    const [email] = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.tenant_id, w.tenant_id), eq(users.id, w.owner.id)));
    await deactivateUser(
      { tenant_id: w.tenant_id, user_id: w.owner.id, actor_id: w.admin.id, actor_kind: "user" },
      db,
    );
    const paused = async () =>
      (
        await db
          .select({ reason: tasks.paused_reason, paused_at: tasks.paused_at })
          .from(tasks)
          .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, run.task_id)))
      )[0];
    expect((await paused())?.reason).toBe("owner_unavailable");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "aborted",
      failure_code: "owner_unavailable",
    });
    expect(await workQueuedTurn()).toBe(true);
    expect((await runRow(w, run.id)).state).toBe("aborted");
    await createUser(
      { tenant_id: w.tenant_id, email: email?.email ?? "", actor_id: w.admin.id },
      db,
    );
    expect((await paused())?.reason).toBe("owner_unavailable");
  }, 180_000);
});
