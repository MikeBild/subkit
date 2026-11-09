import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  applyTurnEvent,
  errorFrameToEvents,
  initialSessionState,
  lastAssistantText,
  lastExecutionResult,
  renderExecutionOutput,
} from "./turn-event-model.ts";

test("activity and diff use the supplied instant and preserve their source state", () => {
  fc.assert(
    fc.property(fc.integer(), fc.string(), (now, label) => {
      const initial = initialSessionState(null);
      const before = structuredClone(initial);
      const activity = applyTurnEvent(initial, { type: "activity", phase: "tool", label }, now);
      expect(activity.activity?.updated_at).toBe(now);
      expect(activity.activity?.label).toBe(label);
      const diff = applyTurnEvent(
        initial,
        { type: "diff", title: label, language: "text", hunks: [] },
        now,
      );
      expect(diff.diffs[0]?.id).toBe(`diff-0-${now}`);
      const next = applyTurnEvent(
        diff,
        { type: "diff", title: label, language: "text", hunks: [] },
        now,
      );
      expect(next.diffs[1]?.id).toBe(`diff-1-${now}`);
      expect(diff.diffs).toHaveLength(1);
      expect(initial).toEqual(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("tool lifecycle merges patches, records failures, and clears validation only after success", () => {
  let state = applyTurnEvent(
    initialSessionState("conversation"),
    { type: "validation_error", errors: [{ path: "input", message: "required" }] },
    1,
  );
  state = applyTurnEvent(
    state,
    {
      type: "tool_call_start",
      call_id: "call",
      tool: "run_workflow",
      input_partial: { first: 1 },
      parent_message_id: "assistant-1",
    },
    2,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_delta", call_id: "call", input_patch: { second: 2 } },
    3,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_end", call_id: "call", input: { final: true } },
    4,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_result", call_id: "call", tool: "run_workflow", output: { ok: false } },
    5,
  );
  expect(state.toolCalls).toEqual([
    {
      id: "call",
      name: "run_workflow",
      args: { final: true },
      status: "failed",
      result: { ok: false },
      parent_message_id: "assistant-1",
    },
  ]);
  expect(state.validationErrors).toEqual([]);

  state = applyTurnEvent(
    state,
    { type: "tool_result", call_id: "missing", tool: "wf_followup", output: { data: { id: 1 } } },
    6,
  );
  expect(lastExecutionResult(state)).toEqual({ tool: "wf_followup", output: { id: 1 } });
});

test("completion, citation attachment, suggestions, and error frames retain their public state contracts", () => {
  let state = applyTurnEvent(
    initialSessionState(null),
    {
      type: "elicit_request",
      elicitation_id: "elicit",
      tool_name: "ask",
      summary: "Need a choice",
      input: { choices: ["a"] },
    },
    1,
  );
  state = applyTurnEvent(
    state,
    {
      type: "completed",
      status: "awaiting_input",
      usage: { turn_tokens: 7, remaining_monthly_budget_tokens: null },
    },
    2,
  );
  expect(state.status).toBe("awaiting_input");
  expect(state.pendingElicitation?.id).toBe("elicit");
  expect(state.sessionTotalTokens).toBe(7);
  state = applyTurnEvent(state, { type: "committed", workflow_id: "workflow" }, 3);
  expect(state.committedWorkflowId).toBe("workflow");
  expect(state.pendingElicitation).toBeNull();

  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "assistant", content: "answer" },
    4,
  );
  state = applyTurnEvent(
    state,
    {
      type: "citations",
      parent_message_id: "assistant",
      citations: [{ source_type: "product_doc", id: "doc" }],
    },
    5,
  );
  state = applyTurnEvent(
    state,
    { type: "next_suggestion", suggestion: "continue", kind: "text", reason: "offer-detected" },
    6,
  );
  expect(lastAssistantText(state)).toBe("answer");
  expect(state.messages.at(-1)?.citations?.[0]?.id).toBe("doc");
  expect(state.nextSuggestion).toEqual({ suggestion: "continue", kind: "text" });
  expect(state.nextSuggestionReason).toBe("offer-detected");

  expect(
    errorFrameToEvents({
      code: "pending_elicitation_blocked",
      message: "blocked",
      details: { pending_elicitation: { id: "p", tool_name: "ask", input: { x: 1 } } },
    }),
  ).toEqual([
    {
      type: "validation_error",
      errors: [{ path: "pending_elicitation_blocked", message: "blocked" }],
    },
    { type: "elicit_request", elicitation_id: "p", tool_name: "ask", summary: "", input: { x: 1 } },
  ]);
});

test("execution rendering samples structured values and reports a bounded printable result", () => {
  expect(
    renderExecutionOutput(
      { tool: "run_workflow", output: { rows: [1, 2, 3], nested: { ok: true } } },
      { maxArrayItems: 2 },
    ),
  ).toBe(
    '[run_workflow] result:\n{\n  "rows": [\n    1,\n    2,\n    "… sampled 2 of 3 items"\n  ],\n  "nested": {\n    "ok": true\n  }\n}',
  );
  expect(renderExecutionOutput({ tool: "run_workflow", output: "abcdef" }, { maxChars: 3 })).toBe(
    "[run_workflow] result:\nabc\n… [truncated 3 chars]",
  );
});

test("message replay consumes streamed tails and replaces local or persisted user echoes", () => {
  let state = initialSessionState(null);
  state = applyTurnEvent(state, { type: "text_delta", text: "hello" }, 1);
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "assistant", content: "hello world" },
    2,
  );
  expect(state.expectedStreamTail).toBe(" world");
  state = applyTurnEvent(state, { type: "text_delta", text: " " }, 3);
  state = applyTurnEvent(state, { type: "text_delta", text: "world" }, 4);
  expect(state.expectedStreamTail).toBe("");
  expect(state.streamingAssistantText).toBe("");
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "assistant", content: "hello world again" },
    5,
  );
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]?.content).toBe("hello world again");

  state = applyTurnEvent(state, { type: "message", role: "user", content: "draft" }, 6);
  state = applyTurnEvent(
    state,
    { type: "message", role: "user", id: "persisted", content: "draft" },
    7,
  );
  expect(state.messages.at(-1)).toMatchObject({ role: "user", id: "persisted", content: "draft" });
  expect(state.expectedStreamTail).toBe("");
});

test("result selection skips unusable calls and error framing rejects malformed pending payloads", () => {
  const state = {
    ...initialSessionState(null),
    toolCalls: [
      { id: "a", name: "other", args: {}, status: "done" as const, result: "ignored" },
      { id: "b", name: "run_workflow", args: {}, status: "done" as const, result: { ok: false } },
      { id: "c", name: "wf_empty", args: {}, status: "done" as const, result: { data: null } },
      { id: "d", name: "call_connector", args: {}, status: "done" as const, result: 42 },
    ],
  };
  expect(lastExecutionResult(state)).toEqual({ tool: "call_connector", output: 42 });
  expect(lastAssistantText(initialSessionState(null))).toBe("");

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(renderExecutionOutput({ tool: "query", output: circular })).toBe(
    "[query] result:\n[object Object]",
  );
  expect(
    errorFrameToEvents({
      code: "elicitation_validation_failed",
      message: "invalid",
      details: { pending_elicitation: { id: 1, tool_name: "ask" } },
    }),
  ).toEqual([
    {
      type: "validation_error",
      errors: [{ path: "elicitation_validation_failed", message: "invalid" }],
    },
  ]);
});

test("stream mismatches, ancillary events, and absent attachments preserve reducer boundaries", () => {
  let state = initialSessionState(null);
  state = applyTurnEvent(state, { type: "message", role: "assistant", content: "first" }, 1);
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", content: "first extended" },
    2,
  );
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]?.content).toBe("first extended");

  state = applyTurnEvent(state, { type: "text_delta", text: "prefix" }, 3);
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "a", content: "prefix tail" },
    4,
  );
  state = applyTurnEvent(state, { type: "text_delta", text: " tail and more" }, 5);
  expect(state.streamingAssistantText).toBe(" and more");
  state = applyTurnEvent(state, { type: "text_delta", text: "prefix" }, 6);
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "b", content: "prefix tail" },
    7,
  );
  state = applyTurnEvent(state, { type: "text_delta", text: "mismatch" }, 8);
  expect(state.streamingAssistantText).toBe("mismatch");

  state = applyTurnEvent(
    state,
    {
      type: "tool_log",
      call_id: "call",
      tool: "run_workflow",
      level: "warn",
      message: "slow",
      ts: "t",
    },
    9,
  );
  state = applyTurnEvent(state, { type: "data_part", data_type: "rows", payload: [1] }, 10);
  expect(state.toolLogs).toEqual([
    { call_id: "call", tool: "run_workflow", level: "warn", message: "slow", ts: "t" },
  ]);
  expect(state.dataParts).toEqual([{ data_type: "rows", payload: [1] }]);

  const noCitationTarget = applyTurnEvent(state, { type: "citations", citations: [] }, 11);
  expect(noCitationTarget).toBe(state);
  const withoutAssistant = applyTurnEvent(
    initialSessionState(null),
    { type: "citations", citations: [{ source_type: "knowledge_chunk", id: "missing" }] },
    12,
  );
  expect(withoutAssistant.messages).toEqual([]);
  expect(lastExecutionResult(initialSessionState(null))).toBeNull();
});

test("diff and citation lookup tolerate absent assistant entries without attaching evidence", () => {
  const sparse = initialSessionState(null);
  sparse.messages.length = 1;
  const withDiff = applyTurnEvent(
    sparse,
    { type: "diff", title: "no assistant parent", language: "text", hunks: [] },
    1,
  );
  expect(withDiff.diffs[0]).toEqual({
    id: "diff-0-1",
    title: "no assistant parent",
    language: "text",
    hunks: [],
  });

  const noAssistant = initialSessionState(null);
  const unchanged = applyTurnEvent(
    noAssistant,
    {
      type: "citations",
      parent_message_id: "missing",
      citations: [{ source_type: "product_doc", id: "doc" }],
    },
    2,
  );
  expect(unchanged).toBe(noAssistant);

  let withAssistant = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "assistant", id: "answer", content: "answer" },
    3,
  );
  withAssistant = applyTurnEvent(
    withAssistant,
    {
      type: "citations",
      parent_message_id: "answer",
      citations: [{ source_type: "product_doc", id: "doc" }],
    },
    4,
  );
  expect(withAssistant.messages[0]?.citations).toEqual([{ source_type: "product_doc", id: "doc" }]);

  let twoAssistants = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "assistant", id: "older", content: "older" },
    5,
  );
  twoAssistants = applyTurnEvent(
    twoAssistants,
    { type: "message", role: "assistant", id: "newer", content: "newer" },
    6,
  );
  twoAssistants = applyTurnEvent(
    twoAssistants,
    {
      type: "citations",
      parent_message_id: "older",
      citations: [{ source_type: "knowledge_chunk", id: "older-source" }],
    },
    7,
  );
  expect(twoAssistants.messages[0]?.citations?.[0]?.id).toBe("older-source");
  expect(twoAssistants.messages[1]?.citations).toBeUndefined();

  const unknownParent = applyTurnEvent(
    twoAssistants,
    {
      type: "citations",
      parent_message_id: "not-present",
      citations: [{ source_type: "knowledge_chunk", id: "ignored" }],
    },
    8,
  );
  expect(unknownParent).toBe(twoAssistants);
});

test("event reducer preserves explicit empty metadata and every terminal state boundary", () => {
  let state = initialSessionState("conversation");
  state = applyTurnEvent(
    state,
    {
      type: "activity",
      phase: "idle",
      label: "",
      tool_name: "",
      call_id: "",
      last_completed: { tool_name: "", ok: false, duration_ms: 0 },
    },
    1,
  );
  expect(state.activity).toEqual({
    phase: "idle",
    label: "",
    tool_name: "",
    call_id: "",
    last_completed: { tool_name: "", ok: false, duration_ms: 0 },
    updated_at: 1,
  });
  state = applyTurnEvent(
    state,
    { type: "elicit_request", elicitation_id: "e", tool_name: "ask", summary: "", input: null },
    2,
  );
  state = applyTurnEvent(state, { type: "completed", status: "error" }, 3);
  expect(state).toMatchObject({
    status: "completed",
    pendingElicitation: null,
    activity: null,
    expectedStreamTail: "",
    usage: null,
    sessionTotalTokens: 0,
  });
  expect(
    applyTurnEvent(
      state,
      { type: "next_suggestion", suggestion: "", kind: "text", reason: "empty" },
      4,
    ),
  ).toMatchObject({ nextSuggestion: null, nextSuggestionReason: "empty" });
});

test("tool calls distinguish absent calls, scalar patches, false envelopes, and parent identifiers", () => {
  let state = initialSessionState(null);
  const untouched = applyTurnEvent(
    state,
    { type: "tool_call_delta", call_id: "missing", input_patch: { ignored: true } },
    1,
  );
  expect(untouched).not.toBe(state);
  expect(untouched.toolCalls).toEqual([]);
  state = applyTurnEvent(
    state,
    {
      type: "tool_call_start",
      call_id: "scalar",
      tool: "tool",
      input_partial: 0,
      parent_message_id: "",
    },
    2,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_delta", call_id: "scalar", input_patch: { next: true } },
    3,
  );
  expect(state.toolCalls[0]).toMatchObject({ args: { next: true } });
  expect(state.toolCalls[0]).not.toHaveProperty("parent_message_id");
  state = applyTurnEvent(
    state,
    { type: "tool_result", call_id: "scalar", tool: "tool", output: { ok: false, data: 0 } },
    4,
  );
  expect(state.toolCalls[0]).toMatchObject({ status: "failed", result: { ok: false, data: 0 } });
  state = applyTurnEvent(
    state,
    {
      type: "tool_result",
      call_id: "new",
      tool: "tool",
      output: { ok: true },
      parent_message_id: "parent",
    },
    5,
  );
  expect(state.toolCalls[1]).toEqual({
    id: "new",
    name: "tool",
    args: undefined,
    status: "done",
    result: { ok: true },
    parent_message_id: "parent",
  });
});

test("execution selection and rendering retain zero values, exact limits, and absent envelopes", () => {
  const state = {
    ...initialSessionState(null),
    toolCalls: [
      { id: "null", name: "run_workflow", args: null, status: "done" as const, result: null },
      {
        id: "none",
        name: "run_workflow",
        args: null,
        status: "done" as const,
        result: { data: undefined },
      },
      {
        id: "zero",
        name: "tenant_call_connector",
        args: null,
        status: "done" as const,
        result: { data: 0 },
      },
    ],
  };
  expect(lastExecutionResult(state)).toEqual({ tool: "tenant_call_connector", output: 0 });
  expect(lastExecutionResult({ ...state, toolCalls: state.toolCalls.slice(0, 2) })).toBeNull();
  expect(renderExecutionOutput({ tool: "wf_x", output: [1, 2] }, { maxArrayItems: 2 })).toBe(
    "[wf_x] result:\n[\n  1,\n  2\n]",
  );
  expect(renderExecutionOutput({ tool: "wf_x", output: null })).toBe("[wf_x] result:\nnull");
});

test("error-frame recovery requires recognized codes and well-formed object details", () => {
  for (const details of [
    undefined,
    null,
    {},
    { pending_elicitation: null },
    { pending_elicitation: [] },
  ]) {
    expect(errorFrameToEvents({ code: "other", message: "no recovery", details })).toEqual([
      { type: "validation_error", errors: [{ path: "other", message: "no recovery" }] },
    ]);
  }
  expect(
    errorFrameToEvents({
      code: "elicitation_validation_failed",
      message: "retry",
      details: {
        pending_elicitation: {
          id: "id",
          tool_name: "",
          summary: 1,
          input: undefined,
          tool_call_id: "",
        },
      },
    }),
  ).toEqual([
    {
      type: "validation_error",
      errors: [{ path: "elicitation_validation_failed", message: "retry" }],
    },
    {
      type: "elicit_request",
      elicitation_id: "id",
      tool_name: "",
      summary: "",
      input: {},
      tool_call_id: "",
    },
  ]);
});
