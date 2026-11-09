import { expect, test } from "bun:test";
import {
  applyTurnEvent,
  errorFrameToEvents,
  initialSessionState,
  lastAssistantText,
  lastExecutionResult,
  type MessageState,
  renderExecutionOutput,
} from "./turn-event-model.ts";

test("initial state and reducer outputs do not invent optional keys or mutate prior messages", () => {
  const initial = initialSessionState("id");
  expect(initial.status).toBe("running");
  expect(initial.validationErrors).toEqual([]);
  expect(initial.messages).toEqual([]);
  const activity = applyTurnEvent(
    initial,
    { type: "activity", phase: "tool", label: "working" },
    1,
  );
  expect(activity.activity).toEqual({ phase: "tool", label: "working", updated_at: 1 });
  expect(initial.activity).toBeNull();

  const messages: MessageState[] = [{ role: "assistant", id: "a", content: "first" }];
  const withCitation = applyTurnEvent(
    { ...initial, messages },
    { type: "citations", citations: [{ source_type: "product_doc", id: "source" }] },
    2,
  );
  expect(messages[0]?.citations).toBeUndefined();
  expect(withCitation.messages).not.toBe(messages);
  expect(withCitation.messages[0]?.citations?.[0]?.id).toBe("source");
});

test("sparse public state and execution aliases retain safe lookup behavior", () => {
  const sparse = initialSessionState(null);
  sparse.messages.length = 2;
  sparse.messages[1] = { role: "assistant", id: "assistant", content: "answer" };
  expect(lastAssistantText(sparse)).toBe("answer");
  expect(
    applyTurnEvent(
      sparse,
      { type: "citations", citations: [{ source_type: "connector_doc", id: "doc" }] },
      1,
    ).messages[1]?.citations,
  ).toEqual([{ source_type: "connector_doc", id: "doc" }]);
  const executions = {
    ...initialSessionState(null),
    toolCalls: [
      { id: "one", name: "dry_run_workflow", args: null, status: "done" as const, result: "dry" },
      { id: "two", name: "wf_named", args: null, status: "done" as const, result: "named" },
    ],
  };
  expect(lastExecutionResult(executions)).toEqual({ tool: "wf_named", output: "named" });
  expect(
    lastExecutionResult({ ...executions, toolCalls: executions.toolCalls.slice(0, 1) }),
  ).toEqual({
    tool: "dry_run_workflow",
    output: "dry",
  });
});

test("null outputs and recovery details stay absent at exact boundaries", () => {
  expect(
    lastExecutionResult({
      ...initialSessionState(null),
      toolCalls: [
        {
          id: "null-data",
          name: "run_workflow",
          args: null,
          status: "done" as const,
          result: { data: null },
        },
      ],
    }),
  ).toBeNull();
  expect(renderExecutionOutput({ tool: "wf_x", output: "abc" }, { maxChars: 3 })).toBe(
    "[wf_x] result:\nabc",
  );
  expect(
    errorFrameToEvents({
      code: "unrecognized",
      message: "not an elicitation",
      details: { pending_elicitation: { id: "id", tool_name: "tool" } },
    }),
  ).toHaveLength(1);
  expect(
    errorFrameToEvents({ code: "pending_elicitation_blocked", message: "missing details" }),
  ).toHaveLength(1);
  expect(
    errorFrameToEvents({
      code: "pending_elicitation_blocked",
      message: "bad call id",
      details: { pending_elicitation: { id: "id", tool_name: "tool", tool_call_id: 1 } },
    })[1],
  ).toEqual({
    type: "elicit_request",
    elicitation_id: "id",
    tool_name: "tool",
    summary: "",
    input: {},
  });
});

test("assistant identity replay never replaces a longer persisted message with a shorter retry", () => {
  let state = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "assistant", id: "same", content: "long persisted answer" },
    1,
  );
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "same", content: "short" },
    2,
  );
  expect(state.messages).toEqual([
    {
      role: "assistant",
      id: "same",
      content: "long persisted answer",
      parts: [{ type: "text", text: "long persisted answer" }],
    },
  ]);

  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "same", content: "long persisted answer plus tail" },
    3,
  );
  expect(state.messages).toEqual([
    {
      role: "assistant",
      id: "same",
      content: "long persisted answer plus tail",
      parts: [{ type: "text", text: "long persisted answer plus tail" }],
    },
  ]);
});

test("assistant replay matches assistant identities only and retains sibling messages", () => {
  let state = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "user", id: "shared", content: "user original" },
    1,
  );
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "assistant", content: "assistant original" },
    2,
  );
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "shared", content: "new assistant" },
    3,
  );
  expect(state.messages.map((message) => [message.role, message.id, message.content])).toEqual([
    ["user", "shared", "user original"],
    ["assistant", "assistant", "assistant original"],
    ["assistant", "shared", "new assistant"],
  ]);
});

test("replayed assistant prefixes carry only the unseen suffix into the stream tail", () => {
  const prior = {
    ...initialSessionState(null),
    expectedStreamTail: "existing ",
    messages: [{ role: "assistant" as const, id: "same", content: "prefix" }],
  };
  const next = applyTurnEvent(
    prior,
    { type: "message", role: "assistant", id: "same", content: "prefix suffix" },
    1,
  );
  expect(next.expectedStreamTail).toBe("existing  suffix");
  expect(prior.messages[0]?.content).toBe("prefix");
});

test("local user echoes never cause non-user messages to replace user history", () => {
  let state = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "user", content: "draft" },
    1,
  );
  state = applyTurnEvent(state, { type: "message", role: "system", content: "notice" }, 2);
  expect(state.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "draft"],
    ["system", "notice"],
  ]);
});

test("tool deltas target their matching call and starts retain a completed terminal state", () => {
  let state = initialSessionState(null);
  state = applyTurnEvent(
    state,
    { type: "tool_call_start", call_id: "one", tool: "first", input_partial: { value: 1 } },
    1,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_start", call_id: "two", tool: "second", input_partial: { value: 2 } },
    2,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_delta", call_id: "two", input_patch: { extra: true } },
    3,
  );
  expect(state.toolCalls.map((call) => call.args)).toEqual([
    { value: 1 },
    { value: 2, extra: true },
  ]);
  state = applyTurnEvent(state, { type: "completed", status: "completed" }, 4);
  state = applyTurnEvent(
    state,
    { type: "tool_call_start", call_id: "three", tool: "third", input_partial: {} },
    5,
  );
  expect(state.status).toBe("completed");
});

test("assistant replay normalizes whitespace while preserving earlier sibling messages", () => {
  let state = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "user", content: "keep me" },
    1,
  );
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "same", content: "answer   " },
    2,
  );
  state = applyTurnEvent(
    state,
    { type: "message", role: "assistant", id: "same", content: "answer" },
    3,
  );
  expect(state.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "keep me"],
    ["assistant", "answer   "],
  ]);
});

test("tool result and delta preserve null outputs, array arguments, and elicit identifiers", () => {
  let state = initialSessionState(null);
  state = applyTurnEvent(
    state,
    { type: "tool_call_start", call_id: "array", tool: "tool", input_partial: ["first"] },
    1,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_delta", call_id: "array", input_patch: { second: true } },
    2,
  );
  expect(state.toolCalls[0]?.args).toEqual({ 0: "first", second: true });
  state = applyTurnEvent(
    state,
    { type: "tool_result", call_id: "null", tool: "tool", output: null },
    3,
  );
  expect(state.toolCalls[1]).toMatchObject({ status: "done", result: null });
  state = applyTurnEvent(
    state,
    {
      type: "elicit_request",
      elicitation_id: "elicit",
      tool_name: "ask",
      tool_call_id: "call",
      parent_message_id: "parent",
      summary: "choose",
      input: {},
    },
    4,
  );
  expect(state.pendingElicitation).toMatchObject({
    id: "elicit",
    tool_name: "ask",
    tool_call_id: "call",
    parent_message_id: "parent",
  });
});

test("callable tool output with an own failure marker remains an opaque successful value", () => {
  const callable = Object.assign(() => undefined, { ok: false });
  const state = applyTurnEvent(
    initialSessionState(null),
    { type: "tool_result", call_id: "callable", tool: "tool", output: callable },
    1,
  );
  expect(state.toolCalls[0]).toMatchObject({ status: "done", result: callable });
});

test("persisted user echoes compare normalized content without inventing optional state fields", () => {
  let state = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "user", id: "old", content: " draft " },
    1,
  );
  state = applyTurnEvent(state, { type: "message", role: "user", id: "new", content: "draft" }, 2);
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]).toMatchObject({ id: "new", content: "draft" });
  expect(state).not.toHaveProperty("expectedStreamTail.extra");

  const activity = applyTurnEvent(
    initialSessionState(null),
    { type: "activity", phase: "idle", label: "idle" },
    3,
  ).activity;
  expect(activity).not.toHaveProperty("tool_name");
  expect(activity).not.toHaveProperty("call_id");
  expect(activity).not.toHaveProperty("last_completed");
  expect(Object.keys(activity ?? {})).toEqual(["phase", "label", "updated_at"]);
});

test("a user message matching an assistant never rewrites the assistant history", () => {
  let state = applyTurnEvent(
    initialSessionState(null),
    { type: "message", role: "assistant", id: "assistant", content: "same text" },
    1,
  );
  state = applyTurnEvent(
    state,
    { type: "message", role: "user", id: "user", content: "same text" },
    2,
  );
  expect(state.messages.map((message) => [message.role, message.id])).toEqual([
    ["assistant", "assistant"],
    ["user", "user"],
  ]);
});

test("equal same-id replay refreshes render parts without dropping earlier messages", () => {
  const initial = {
    ...initialSessionState(null),
    messages: [
      { role: "user" as const, content: "keep" },
      { role: "assistant" as const, id: "same", content: "body", parts: [] },
    ],
  };
  const next = applyTurnEvent(
    initial,
    { type: "message", role: "assistant", id: "same", content: "body" },
    1,
  );
  expect(next.messages).toEqual([
    { role: "user", content: "keep" },
    { role: "assistant", id: "same", content: "body", parts: [{ type: "text", text: "body" }] },
  ]);
  expect(initial.messages[1]?.parts).toEqual([]);
});

test("prior assistant replay accounts for prefixes while a prior user never acts as a stream prefix", () => {
  const priorAssistant = {
    ...initialSessionState(null),
    expectedStreamTail: "old ",
    messages: [{ role: "assistant" as const, content: "prefix" }],
  };
  const replayed = applyTurnEvent(
    priorAssistant,
    { type: "message", role: "assistant", content: "prefix tail" },
    1,
  );
  expect(replayed.messages).toHaveLength(1);
  expect(replayed.expectedStreamTail).toBe("old  tail");

  const afterUser = applyTurnEvent(
    {
      ...initialSessionState(null),
      messages: [{ role: "user" as const, content: "previous user" }],
    },
    { type: "message", role: "assistant", content: "Stryker was here!" },
    2,
  );
  expect(afterUser.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
});

test("non-user messages preserve a pending stream tail while matching tail text clears it", () => {
  const initial = { ...initialSessionState(null), expectedStreamTail: "tail" };
  const system = applyTurnEvent(initial, { type: "message", role: "system", content: "notice" }, 1);
  expect(system.expectedStreamTail).toBe("tail");
  const consumed = applyTurnEvent(
    { ...initialSessionState(null), expectedStreamTail: "tail" },
    { type: "text_delta", text: "tail" },
    2,
  );
  expect(consumed).toMatchObject({ expectedStreamTail: "", streamingAssistantText: "" });
});

test("callable arguments stay opaque, sparse tool arrays stay safe, and undefined results are skipped", () => {
  const callable = Object.assign(() => undefined, { own: "value" });
  let state = applyTurnEvent(
    initialSessionState(null),
    { type: "tool_call_start", call_id: "call", tool: "tool", input_partial: callable },
    1,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_delta", call_id: "call", input_patch: { next: true } },
    2,
  );
  expect(state.toolCalls[0]?.args).toEqual({ next: true });

  state = applyTurnEvent(
    initialSessionState(null),
    { type: "tool_call_start", call_id: "null-args", tool: "tool", input_partial: null },
    3,
  );
  state = applyTurnEvent(
    state,
    { type: "tool_call_delta", call_id: "null-args", input_patch: "unchanged scalar" },
    4,
  );
  expect(state.toolCalls[0]?.args).toBe("unchanged scalar");

  const sparse = initialSessionState(null);
  sparse.toolCalls.length = 2;
  sparse.toolCalls[1] = {
    id: "failed",
    name: "run_workflow",
    args: null,
    status: "failed",
    result: "must be skipped",
  };
  expect(lastExecutionResult(sparse)).toBeNull();
  expect(
    lastExecutionResult({
      ...initialSessionState(null),
      toolCalls: [
        { id: "none", name: "run_workflow", args: null, status: "done", result: undefined },
      ],
    }),
  ).toBeNull();
});

test("callable pending-elicit payloads remain untrusted unknown values", () => {
  const callable = Object.assign(() => undefined, { id: "id", tool_name: "tool" });
  expect(
    errorFrameToEvents({
      code: "pending_elicitation_blocked",
      message: "blocked",
      details: { pending_elicitation: callable },
    }),
  ).toEqual([
    {
      type: "validation_error",
      errors: [{ path: "pending_elicitation_blocked", message: "blocked" }],
    },
  ]);
});

test("prior-message whitespace and persisted echo identity drive replacement decisions", () => {
  const trimmedPrior = applyTurnEvent(
    {
      ...initialSessionState(null),
      messages: [{ role: "assistant" as const, content: "answer  " }],
    },
    { type: "message", role: "assistant", content: "answer" },
    1,
  );
  expect(trimmedPrior.messages).toHaveLength(1);

  const trimmedIncoming = applyTurnEvent(
    { ...initialSessionState(null), messages: [{ role: "assistant" as const, content: "answer" }] },
    { type: "message", role: "assistant", content: " answer" },
    2,
  );
  expect(trimmedIncoming.messages).toHaveLength(1);

  const samePersistedId = applyTurnEvent(
    {
      ...initialSessionState(null),
      messages: [{ role: "user" as const, id: "same", content: "same" }],
    },
    { type: "message", role: "user", id: "same", content: "same" },
    3,
  );
  expect(samePersistedId.messages).toHaveLength(2);

  const whitespaceIncoming = applyTurnEvent(
    {
      ...initialSessionState(null),
      messages: [{ role: "user" as const, id: "old", content: "draft" }],
    },
    { type: "message", role: "user", id: "new", content: "draft " },
    4,
  );
  expect(whitespaceIncoming.messages).toHaveLength(1);
});

test("stream tail overflow resets its marker and sparse citations remain safe", () => {
  const overflow = applyTurnEvent(
    { ...initialSessionState(null), expectedStreamTail: "tail" },
    { type: "text_delta", text: "tail plus" },
    1,
  );
  expect(overflow).toMatchObject({ expectedStreamTail: "", streamingAssistantText: " plus" });

  const sparse = initialSessionState(null);
  sparse.messages.length = 2;
  sparse.messages[1] = { role: "user", content: "not an assistant" };
  expect(
    applyTurnEvent(
      sparse,
      { type: "citations", citations: [{ source_type: "product_doc", id: "missing" }] },
      2,
    ),
  ).toBe(sparse);
});

test("an assistant message unrelated to streamed content clears the expected tail", () => {
  const next = applyTurnEvent(
    { ...initialSessionState(null), streamingAssistantText: "drafting" },
    { type: "message", role: "assistant", content: "final answer" },
    1,
  );

  expect(next.expectedStreamTail).toBe("");
  expect(next.streamingAssistantText).toBe("");
  expect(next.messages).toMatchObject([{ role: "assistant", content: "final answer" }]);
});
