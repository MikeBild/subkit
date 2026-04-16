// Unit tests for apps/sk/src/turn-event.ts. Ported from the
// equivalent tests under apps/cli so the reducer stays behavior-
// compatible between the two binaries.

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

  test("tool_call followed by tool_result marks the call done", () => {
    let s = initialSessionState("c1");
    s = applyTurnEvent(s, { type: "tool_call", tool: "propose_step", input: { x: 1 }, id: "t1" });
    s = applyTurnEvent(s, {
      type: "tool_result",
      tool: "propose_step",
      output: { ok: true },
      id: "t1",
    });
    expect(s.toolCalls.length).toBe(1);
    expect(s.toolCalls[0]?.status).toBe("done");
    expect((s.toolCalls[0]?.result as { ok: boolean }).ok).toBe(true);
  });

  test("approval_request flips the session status and stores the diff payload", () => {
    let s = initialSessionState("c1");
    s = applyTurnEvent(s, {
      type: "approval_request",
      approval_id: "a1",
      kind: "commit_draft",
      summary: "commit 1-step workflow",
      diff: { name: "new-workflow", steps: [{ id: "s1", kind: "transform" }] },
    });
    expect(s.status).toBe("awaiting_approval");
    expect(s.pendingApproval?.id).toBe("a1");
    expect(s.pendingApproval?.kind).toBe("commit_draft");
    expect(s.pendingApproval?.summary).toBe("commit 1-step workflow");
    const diff = s.pendingApproval?.diff as { name?: string; steps?: unknown[] };
    expect(diff?.name).toBe("new-workflow");
    expect(Array.isArray(diff?.steps)).toBe(true);
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
