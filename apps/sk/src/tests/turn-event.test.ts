// Unit tests for apps/sk/src/turn-event.ts. Shared reducer coverage
// keeps the interactive and headless `sk` surfaces behavior-compatible.

import { describe, expect, test } from "bun:test";
import {
  applyTurnEvent,
  initialSessionState,
  lastAssistantText,
  type TurnEvent,
} from "@cli-core/index.ts";

describe("sk turn-event reducer", () => {
  test("folds a message event into the history", () => {
    let s = initialSessionState("c1");
    s = applyTurnEvent(s, {
      type: "message",
      role: "assistant",
      content: { text: "hello there" },
    });
    expect(s.messages[0]?.role).toBe("assistant");
    expect(s.messages[0]?.content).toBe("hello there");
  });

  test("tool_call_start followed by tool_result marks the call done", () => {
    let s = initialSessionState("c1");
    s = applyTurnEvent(s, {
      type: "tool_call_start",
      call_id: "t1",
      tool: "propose_step",
      input_partial: { x: 1 },
    });
    s = applyTurnEvent(s, {
      type: "tool_result",
      call_id: "t1",
      tool: "propose_step",
      output: { ok: true },
    });
    expect(s.toolCalls.length).toBe(1);
    expect(s.toolCalls[0]?.status).toBe("done");
    expect((s.toolCalls[0]?.result as { ok: boolean }).ok).toBe(true);
  });

  test("elicit_request flips the session status and stores the input payload", () => {
    let s = initialSessionState("c1");
    s = applyTurnEvent(s, {
      type: "elicit_request",
      elicitation_id: "a1",
      tool_name: "ask_user_confirm",
      summary: "commit 1-step workflow",
      input: {
        question: "Commit?",
        kind: "save_workflow_draft",
        diff: { name: "new-workflow", steps: [{ id: "s1", kind: "transform" }] },
      },
    });
    expect(s.status).toBe("awaiting_input");
    expect(s.pendingElicitation?.id).toBe("a1");
    expect(s.pendingElicitation?.tool_name).toBe("ask_user_confirm");
    expect(s.pendingElicitation?.summary).toBe("commit 1-step workflow");
    const input = s.pendingElicitation?.input as {
      kind?: string;
      diff?: { name?: string; steps?: unknown[] };
    };
    expect(input.kind).toBe("save_workflow_draft");
    expect(input.diff?.name).toBe("new-workflow");
    expect(Array.isArray(input.diff?.steps)).toBe(true);
  });

  test("committed + completed chain marks the session committed", () => {
    let s = initialSessionState("c1");
    s = applyTurnEvent(s, { type: "committed", workflow_id: "wf-1" });
    s = applyTurnEvent(s, {
      type: "completed",
      status: "committed",
      usage: { turn_tokens: 42, remaining_monthly_budget_tokens: 9958 },
    });
    expect(s.committedWorkflowId).toBe("wf-1");
    expect(s.status).toBe("completed");
    expect(s.usage?.turn_tokens).toBe(42);
  });

  test("validation_error surfaces the errors list and flips status", () => {
    let s = initialSessionState("c1");
    const errs = [{ path: "steps.0.connector_id", message: "required" }];
    s = applyTurnEvent(s, { type: "validation_error", errors: errs });
    expect(s.status).toBe("error");
    expect(s.validationErrors).toEqual(errs);
  });

  test("tool_call_start AFTER a validation_error clears stale errors and resumes running", () => {
    // Mid-turn iteration: the LLM saw a validation failure and is
    // trying again. The standalone "validation errors" panel must
    // not linger past the new attempt — the previous draft's errors
    // aren't the user's problem to solve.
    let s = initialSessionState("c1");
    s = applyTurnEvent(s, {
      type: "validation_error",
      errors: [{ path: "steps.0", message: "missing connector_id" }],
    });
    expect(s.status).toBe("error");
    expect(s.validationErrors).toHaveLength(1);

    s = applyTurnEvent(s, {
      type: "tool_call_start",
      call_id: "call-2",
      tool: "build_workflow",
    });
    expect(s.validationErrors).toEqual([]);
    expect(s.status).toBe("running");
  });

  test("tool_call_start does NOT clear errors when the turn never went into error state", () => {
    // Sanity: starting a tool call from a fresh (running) session
    // shouldn't touch validationErrors or transition status weirdly.
    let s = initialSessionState("c1");
    expect(s.status).toBe("running");
    s = applyTurnEvent(s, {
      type: "tool_call_start",
      call_id: "call-1",
      tool: "list_workflows",
    });
    expect(s.validationErrors).toEqual([]);
    expect(s.status).toBe("running");
  });

  test("lastAssistantText returns the most recent assistant message", () => {
    const events: TurnEvent[] = [
      { type: "message", role: "user", content: { text: "hi" } },
      { type: "message", role: "assistant", content: { text: "hey" } },
      { type: "message", role: "assistant", content: { text: "final" } },
    ];
    let s = initialSessionState("c1");
    for (const ev of events) s = applyTurnEvent(s, ev);
    expect(lastAssistantText(s)).toBe("final");
  });

  test("unknown event types are ignored", () => {
    let s = initialSessionState("c1");
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
    s = applyTurnEvent(s, { type: "garbage" } as any);
    expect(s.messages.length).toBe(0);
  });
});
