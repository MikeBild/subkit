import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversationToolCalls, taskRuns } from "../../db/schema/index.ts";
import {
  clearQueue,
  db,
  ownedTask,
  queuedJobs,
  runRow,
  script,
  startedRun,
  useTaskRunQueue,
  type Workspace,
  workspace,
} from "../../queue/handlers/task-run-turn-fixtures.ts";
import { continueTaskRunOfConversation } from "../../tasks/run-driver.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { expireDueElicitations } from "../elicitation-expiry.ts";
import { requestLocalConfirmation } from "../local-confirmation.ts";
import { respondElicitationForTest } from "./setup.ts";

useTaskRunQueue("local-confirmation-run");

const NOTHING_CHANGED = {
  de: "Es wurde nichts gesendet oder geändert.",
  en: "Nothing was sent or changed.",
};

async function waitingOnLocalStep(w: Workspace, requested_at: Date) {
  const run = await startedRun(w, await ownedTask(w));
  await clearQueue();
  const [call] = await db
    .insert(conversationToolCalls)
    .values({
      tenant_id: w.tenant_id,
      conversation_id: run.conversation_id,
      tool: "browser_press",
      input: { ref: "e12" },
      output: null,
    })
    .returning({ id: conversationToolCalls.id });
  if (!call) throw new Error("tool call fixture missing");
  const asked = await requestLocalConfirmation(db, {
    tenant_id: w.tenant_id,
    conversation_id: run.conversation_id,
    tool_call_id: call.id,
    parent_message_id: null,
    actor_id: w.owner.id,
    tool: "browser_press",
    args: { ref: "e12" },
    question: "„Senden“ auf portal.example drücken?",
    device: {
      device_id: "d1000000-0000-4000-8000-0000000000e7",
      capability: "browser",
      target: "„Senden“ auf portal.example",
      command_id: "c".repeat(64),
      binding_hash: "b".repeat(64),
    },
    requested_at,
    limits: [],
  });
  await db
    .update(taskRuns)
    .set({ state: "waiting", waiting_reason: "question" })
    .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.id, run.id)));
  return { run, tool_call_id: call.id, elicitation_id: asked.elicitation_id };
}

async function output(tool_call_id: string) {
  const [row] = await db
    .select({ output: conversationToolCalls.output, outcome: conversationToolCalls.outcome })
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.id, tool_call_id));
  return row;
}

describe("a task run goes on after its local step was not confirmed", () => {
  test("nobody confirms in time: the step fails and the run resumes at once", async () => {
    const w = await workspace();
    const step = await waitingOnLocalStep(w, new Date("2026-01-05T09:00:00.000Z"));
    const tally = { expired_count: 0, completed_count: 0 };
    await expireDueElicitations(tally, "local-confirmation-run-tick", db, {
      continue_after_local: async (p) => {
        await continueTaskRunOfConversation(db, { ...p, now: new Date(getTestNow()) });
      },
    });
    expect(await output(step.tool_call_id)).toMatchObject({
      outcome: "expired",
      output: { ok: false, reason: "local_confirmation_expired", message: NOTHING_CHANGED },
    });
    const run = await runRow(w, step.run.id);
    expect(run.state).toBe("running");
    expect(run.waiting_reason).toBeNull();
    expect(await queuedJobs(step.run.id)).toHaveLength(1);
  });

  test("the owner declines: the agent continues with the failed step and the run resumes", async () => {
    const w = await workspace();
    const step = await waitingOnLocalStep(w, new Date(getTestNow()));
    script(step.run.conversation_id, [{ text: "Ich sende nichts und fasse zusammen." }]);
    const owner: ResolvedPrincipal = {
      ...w.owner,
      auth_source: { kind: "browser_session", session_id: "owner-session" },
    };
    const turn = await respondElicitationForTest(
      {
        tenant_id: w.tenant_id,
        conversation_id: step.run.conversation_id,
        elicitation_id: step.elicitation_id,
        actor_id: w.owner.id,
        principal: owner,
        output: { confirmed: false },
        now: new Date(getTestNow() + 60_000),
      },
      db,
    );
    expect(turn.result.status).not.toBe("awaiting_input");
    expect(await output(step.tool_call_id)).toMatchObject({
      outcome: "denied",
      output: { ok: false, reason: "local_confirmation_declined", message: NOTHING_CHANGED },
    });
    expect(
      await continueTaskRunOfConversation(db, {
        tenant_id: w.tenant_id,
        conversation_id: step.run.conversation_id,
        now: new Date(getTestNow()),
      }),
    ).toBe("observed");
    const run = await runRow(w, step.run.id);
    expect(run.state).toBe("running");
    expect(await queuedJobs(step.run.id)).toHaveLength(1);
  });
});
