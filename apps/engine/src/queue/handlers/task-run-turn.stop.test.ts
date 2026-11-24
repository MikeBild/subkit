import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversationLifecycleOperations } from "../../api/operations/conversation-lifecycle.ts";
import { actorOfPrincipal, type OperationScope } from "../../api/operations/index.ts";
import * as lifecycle from "../../conversations/public/lifecycle.ts";
import { conversations, conversationTurns } from "../../db/schema/index.ts";
import { abortTaskRun } from "../../tasks/index.ts";
import { advanceTaskRun, observePersonTurn } from "../../tasks/run-driver.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { enqueueTaskRunTurn } from "./task-run-turn.ts";
import {
  clearQueue,
  db,
  jobOf,
  ownedTask,
  queuedJobs,
  runRow,
  type StartedRun,
  startedRun,
  useTaskRunQueue,
  type Workspace,
  workQueuedTurn,
  workspace,
} from "./task-run-turn-fixtures.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c07);
const FIXED_NOW = new Date(FROZEN_NOW);

useTaskRunQueue("task_run_turn_stop");

async function freshRun(): Promise<{ w: Workspace; run: StartedRun }> {
  const w = await workspace();
  const run = await startedRun(w, await ownedTask(w));
  await clearQueue();
  await enqueueTaskRunTurn(db, jobOf(w, run));
  return { w, run };
}

describe("stopping a task run turn", () => {
  test("a stopped turn waits for the person instead of failing the run", async () => {
    const { w, run } = await freshRun();
    await workQueuedTurn({
      runTurn: async (p) => {
        p.turn_abort_ctrl.abort("conversation_cancelled");
        throw new DOMException("stopped", "AbortError");
      },
    });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "turn_stopped",
      failure_code: null,
    });
  }, 180_000);

  test("stop at the message field ends the turn only: the run waits and the chat goes on", async () => {
    const { w, run } = await freshRun();
    let aborted = false;
    await workQueuedTurn({
      runTurn: async (p) => {
        const scope: OperationScope = {
          db: db as OperationScope["db"],
          tenant_id: w.tenant_id,
          principal: w.owner,
          actor: actorOfPrincipal(w.owner),
        };
        const stopped = await conversationLifecycleOperations(lifecycle).cancel.handler(scope, {
          id: run.conversation_id,
        });
        expect(stopped).toMatchObject({ id: run.conversation_id });
        aborted = p.turn_abort_ctrl.signal.aborted;
        throw new DOMException("stopped", "AbortError");
      },
    });
    expect(aborted).toBe(true);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "turn_stopped",
      failure_code: null,
    });
    const [conversation] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, run.conversation_id)),
      );
    expect(conversation?.status).not.toBe("abandoned");
    const release = {
      db,
      tenant_id: w.tenant_id,
      conversation_id: run.conversation_id,
      turn_id: nextUuid(),
    };
    await observePersonTurn({ ...release, state: "completed" });
    expect(await runRow(w, run.id)).toMatchObject({ state: "running", failure_code: null });
  }, 180_000);

  test("a stopped turn a person drives waits instead of continuing the run", async () => {
    const { w, run } = await freshRun();
    await observePersonTurn({
      db,
      tenant_id: w.tenant_id,
      conversation_id: run.conversation_id,
      turn_id: nextUuid(),
      state: "cancelled",
    });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "turn_stopped",
      failure_code: null,
    });
  }, 180_000);

  test("stopping a queued person turn waits when the scheduler observes it", async () => {
    const { w, run } = await freshRun();
    await clearQueue();
    const [turn] = await db
      .insert(conversationTurns)
      .values({
        tenant_id: w.tenant_id,
        conversation_id: run.conversation_id,
        state: "queued",
      })
      .returning({ id: conversationTurns.id });
    await lifecycle.interruptTaskRunTurn(
      w.tenant_id,
      run.conversation_id,
      w.owner.id,
      db,
      "user",
      w.owner,
    );
    const scope = { tenant_id: w.tenant_id, task_run_id: run.id, now: FIXED_NOW };
    expect(await advanceTaskRun(db, scope)).toBe("observed");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "turn_stopped",
      failure_code: null,
      last_seen_turn_id: turn?.id,
    });
    expect(await queuedJobs(run.id)).toHaveLength(0);
    expect(await advanceTaskRun(db, scope)).toBe("idle");
    expect(await queuedJobs(run.id)).toHaveLength(0);
  }, 180_000);

  test("stop at the message field of a conversation without an open run is no turn stop", async () => {
    const { w, run } = await freshRun();
    await abortTaskRun({ tenant_id: w.tenant_id, principal: w.owner, task_run_id: run.id }, db);
    expect(
      await lifecycle.interruptTaskRunTurn(
        w.tenant_id,
        run.conversation_id,
        w.owner.id,
        db,
        "user",
        w.owner,
      ),
    ).toBeNull();
  }, 180_000);
});
