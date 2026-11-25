import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createElicitation } from "../../conversations/elicitations.ts";
import { cancelConversation } from "../../conversations/service/lifecycle.ts";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { advanceTaskRun, observeTaskRun } from "../../tasks/run-driver.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import {
  db,
  ownedTask,
  runRow,
  type StartedRun,
  startedRun,
  useTaskRunQueue,
  type Workspace,
  workspace,
} from "./task-run-turn-fixtures.ts";

const FIXED_NOW = new Date(FROZEN_NOW);

useTaskRunQueue("task_run_turn_abandoned");

async function abandonedRun(): Promise<{ w: Workspace; run: StartedRun }> {
  const w = await workspace();
  const run = await startedRun(w, await ownedTask(w));
  await cancelConversation(w.tenant_id, run.conversation_id, null, db, "system");
  return { w, run };
}

async function elicitationsOf(w: Workspace, conversation_id: string) {
  return db
    .select({ id: conversationElicitations.id })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, w.tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
      ),
    );
}

async function conversationStatus(w: Workspace, conversation_id: string) {
  const [row] = await db
    .select({ status: conversations.status })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, conversation_id)));
  return row?.status;
}

describe("a question on an abandoned task run conversation", () => {
  test("is refused, opens nothing and holds the run for the person", async () => {
    const { w, run } = await abandonedRun();
    expect(await runRow(w, run.id)).toMatchObject({ state: "running" });

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
    expect(await elicitationsOf(w, run.conversation_id)).toHaveLength(0);
    expect(await conversationStatus(w, run.conversation_id)).toBe("abandoned");
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "conversation_abandoned",
      failure_code: null,
      ended_at: null,
    });
  }, 180_000);

  test("later observations keep the run held instead of failing it", async () => {
    const { w, run } = await abandonedRun();
    await createElicitation(
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

    expect(
      await advanceTaskRun(db, { tenant_id: w.tenant_id, task_run_id: run.id, now: FIXED_NOW }),
    ).toBe("idle");
    const observed = await observeTaskRun(db, {
      tenant_id: w.tenant_id,
      task_run_id: run.id,
      turn: {
        id: null,
        driver: "task",
        failure: { code: "turn_stopped", retry_at: null },
        interrupted: false,
      },
      source: "queue",
    });
    expect(observed?.changed).toBe(false);
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "conversation_abandoned",
      failure_code: null,
    });
    expect(await conversationStatus(w, run.conversation_id)).toBe("abandoned");
  }, 180_000);
});
