// Reducer contract tests — cover the new AI-SDK-UI-style lifecycle
// frames (tool_call_start / tool_call_delta / tool_call_end /
// tool_result_v2 / data_part) and the `awaiting_input` status path.
// Keeps the cli-core surface honest without bringing up React or Ink.

import { describe, expect, test } from "bun:test";
import { applyTurnEvent, initialSessionState } from "../turn-event.ts";

describe("applyTurnEvent — tool-call lifecycle", () => {
  test("tool_call_start appends a running call keyed by call_id", () => {
    const s = initialSessionState("conv-1");
    const next = applyTurnEvent(s, {
      type: "tool_call_start",
      call_id: "call-1",
      tool: "listSkills",
      input_partial: { scope: "tenant" },
    });
    expect(next.toolCalls).toHaveLength(1);
    const call = next.toolCalls[0];
    expect(call?.id).toBe("call-1");
    expect(call?.status).toBe("running");
    expect(call?.args).toEqual({ scope: "tenant" });
  });

  test("tool_call_delta merges into the matching call's args", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, {
      type: "tool_call_start",
      call_id: "call-1",
      tool: "propose_step",
      input_partial: { step: { name: "fetch" } },
    });
    const s2 = applyTurnEvent(s1, {
      type: "tool_call_delta",
      call_id: "call-1",
      input_patch: { step: { url: "https://api" } },
    });
    expect(s2.toolCalls[0]?.args).toEqual({
      step: { url: "https://api" },
    });
  });

  test("tool_call_end replaces args with the final payload", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, {
      type: "tool_call_start",
      call_id: "call-9",
      tool: "askUser.choice",
    });
    const s2 = applyTurnEvent(s1, {
      type: "tool_call_end",
      call_id: "call-9",
      input: { question: "?", options: [] },
    });
    expect(s2.toolCalls[0]?.args).toEqual({ question: "?", options: [] });
  });

  test("tool_result flips the call to done and records the output", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, {
      type: "tool_call_start",
      call_id: "c",
      tool: "listSkills",
    });
    const s2 = applyTurnEvent(s1, {
      type: "tool_result",
      call_id: "c",
      tool: "listSkills",
      output: { count: 3 },
    });
    expect(s2.toolCalls[0]?.status).toBe("done");
    expect(s2.toolCalls[0]?.result).toEqual({ count: 3 });
  });

  test("tool_result without a prior start appends a done call", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, {
      type: "tool_result",
      call_id: "late",
      tool: "searchKnowledge",
      output: { hits: [] },
    });
    expect(s1.toolCalls).toHaveLength(1);
    expect(s1.toolCalls[0]?.status).toBe("done");
  });
});

describe("applyTurnEvent — data parts + status", () => {
  test("data_part frames accumulate on the dataParts sidecar", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, {
      type: "data_part",
      data_type: "data-progress",
      payload: { step: 1, total: 3 },
    });
    const s2 = applyTurnEvent(s1, {
      type: "data_part",
      data_type: "data-skill-candidate",
      payload: { id: "sk-42" },
    });
    expect(s2.dataParts).toHaveLength(2);
    expect(s2.dataParts[0]?.data_type).toBe("data-progress");
    expect(s2.dataParts[1]?.payload).toEqual({ id: "sk-42" });
  });

  test("completed { status: awaiting_input } transitions status correctly", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, { type: "completed", status: "awaiting_input" });
    expect(s1.status).toBe("awaiting_input");
  });

  test("elicit_request transitions status and sets pendingElicitation", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, {
      type: "elicit_request",
      elicitation_id: "elicit-1",
      tool_name: "ask_user_choice",
      summary: "Pick one",
      input: { question: "Pick one", options: [{ value: "a", label: "A" }] },
    });
    expect(s1.status).toBe("awaiting_input");
    expect(s1.pendingElicitation?.id).toBe("elicit-1");
    expect(s1.pendingElicitation?.tool_name).toBe("ask_user_choice");
    expect((s1.pendingElicitation?.input as { question: string }).question).toBe("Pick one");
  });
});
