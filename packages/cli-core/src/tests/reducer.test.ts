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

  test("tool_result with ok=false marks the call failed (not done)", () => {
    const s0 = initialSessionState("conv-1");
    const s1 = applyTurnEvent(s0, {
      type: "tool_call_start",
      call_id: "c-fail",
      tool: "propose_step",
    });
    const s2 = applyTurnEvent(s1, {
      type: "tool_result",
      call_id: "c-fail",
      tool: "propose_step",
      output: { ok: false, data: { errors: [] } },
    });
    expect(s2.toolCalls[0]?.status).toBe("failed");
    expect(s2.toolCalls[0]?.result).toMatchObject({ ok: false });
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

  test("completed terminal status clears any stale pending elicitation", () => {
    const s0 = applyTurnEvent(initialSessionState("conv-1"), {
      type: "elicit_request",
      elicitation_id: "elicit-1",
      tool_name: "ask_user_confirm",
      summary: "Confirm save",
      input: { question: "Save?" },
    });
    const s1 = applyTurnEvent(s0, { type: "completed", status: "active" });
    expect(s1.pendingElicitation).toBeNull();
    expect(s1.status).toBe("completed");
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

describe("applyTurnEvent — streaming frames", () => {
  test("text_delta accumulates into streamingAssistantText", () => {
    let s = initialSessionState("conv-stream");
    s = applyTurnEvent(s, { type: "text_delta", text: "Hello" });
    s = applyTurnEvent(s, { type: "text_delta", text: ", " });
    s = applyTurnEvent(s, { type: "text_delta", text: "world" });
    expect(s.streamingAssistantText).toBe("Hello, world");
  });

  test("message event clears streamingAssistantText for assistant role", () => {
    let s = initialSessionState("conv-stream2");
    s = applyTurnEvent(s, { type: "text_delta", text: "partial" });
    expect(s.streamingAssistantText).toBe("partial");
    s = applyTurnEvent(s, {
      type: "message",
      role: "assistant",
      content: { text: "partial finalised" },
    });
    expect(s.streamingAssistantText).toBe("");
    expect(s.messages[s.messages.length - 1]?.content).toBe("partial finalised");
  });

  test("tool-only assistant turn (content={}) normalises to empty text+parts", () => {
    // Engine loop.ts:1175 emits content={} for a step with no text and
    // no violations — the row exists only as a parent-id anchor for the
    // child tool calls. Without isEffectivelyEmpty the safeStringify
    // fallback would produce parsed.text="{}" and a one-element parts
    // array, leaking a `• sk    {}` line into the transcript and
    // breaking the empty-stub suppression in ink-app.
    const s = applyTurnEvent(initialSessionState("conv-anchor-row"), {
      type: "message",
      role: "assistant",
      content: {},
      id: "msg-anchor-1",
    });
    const m = s.messages[s.messages.length - 1];
    expect(m?.content).toBe("");
    expect(m?.parts).toBeUndefined();
  });

  test("message events keep structured render parts for code blocks and tables", () => {
    const s = applyTurnEvent(initialSessionState("conv-rich"), {
      type: "message",
      role: "assistant",
      content: {
        text: [
          "## Preview",
          "",
          "| name | status |",
          "| --- | --- |",
          "| sync | ok |",
          "",
          "```json",
          '{"ok":true}',
          "```",
        ].join("\n"),
      },
    });
    const parts = s.messages[0]?.parts ?? [];
    expect(parts.map((part) => part.type)).toEqual(["text", "table", "code_block"]);
  });

  test("tool_call_start records explicit parent_message_id", () => {
    const s = initialSessionState("conv-anchor");
    const next = applyTurnEvent(s, {
      type: "tool_call_start",
      call_id: "call-1",
      tool: "listSkills",
      parent_message_id: "msg-7",
    });
    expect(next.toolCalls[0]?.parent_message_id).toBe("msg-7");
  });

  test("tool_call_start without parent_message_id stays unanchored", () => {
    let s = initialSessionState("conv-fallback");
    s = applyTurnEvent(s, {
      type: "message",
      role: "assistant",
      content: { text: "i will look that up" },
      id: "asst-99",
    });
    s = applyTurnEvent(s, {
      type: "tool_call_start",
      call_id: "call-x",
      tool: "list_workflows",
    });
    expect(s.toolCalls[0]?.parent_message_id).toBeUndefined();
  });

  test("elicit_request without parent_message_id stays unanchored", () => {
    let s = initialSessionState("conv-elicit");
    s = applyTurnEvent(s, {
      type: "message",
      role: "assistant",
      content: { text: "shall I save?" },
      id: "asst-42",
    });
    s = applyTurnEvent(s, {
      type: "elicit_request",
      elicitation_id: "elicit-1",
      tool_name: "ask_user_confirm",
      summary: "Confirm save",
      input: { question: "Save the workflow?" },
    });
    expect(s.pendingElicitation?.parent_message_id).toBeUndefined();
  });

  test("a later assistant message does not backfill missing anchors", () => {
    let s = initialSessionState("conv-live");
    s = applyTurnEvent(s, {
      type: "tool_call_start",
      call_id: "call-1",
      tool: "ask_user_form",
    });
    s = applyTurnEvent(s, {
      type: "elicit_request",
      elicitation_id: "elicit-1",
      tool_name: "ask_user_form",
      summary: "Provide the API token",
      input: { fields: [{ key: "token" }] },
    });
    expect(s.toolCalls[0]?.parent_message_id).toBeUndefined();
    expect(s.pendingElicitation?.parent_message_id).toBeUndefined();

    s = applyTurnEvent(s, {
      type: "message",
      role: "assistant",
      content: { text: "Here's the secure form." },
      id: "asst-live-1",
    });
    expect(s.toolCalls[0]?.parent_message_id).toBeUndefined();
    expect(s.pendingElicitation?.parent_message_id).toBeUndefined();
  });

  test("message events with id are stored on the MessageState", () => {
    const s = applyTurnEvent(initialSessionState("c"), {
      type: "message",
      role: "assistant",
      content: { text: "hi" },
      id: "asst-1",
    });
    expect(s.messages[0]?.id).toBe("asst-1");
  });

  test("tool_log appends per-call entries to toolLogs", () => {
    let s = initialSessionState("conv-logs");
    s = applyTurnEvent(s, {
      type: "tool_log",
      call_id: "c1",
      tool: "run_workflow",
      level: "info",
      message: "step 1/3",
      ts: "2026-04-18T00:00:00.000Z",
    });
    s = applyTurnEvent(s, {
      type: "tool_log",
      call_id: "c1",
      tool: "run_workflow",
      level: "info",
      message: "step 2/3",
      ts: "2026-04-18T00:00:01.000Z",
    });
    expect(s.toolLogs).toHaveLength(2);
    expect(s.toolLogs[0]?.message).toBe("step 1/3");
    expect(s.toolLogs[1]?.message).toBe("step 2/3");
  });
});
