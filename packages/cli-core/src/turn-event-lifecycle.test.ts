import { expect, test } from "bun:test";
import {
  applyTurnEvent,
  errorFrameToEvents,
  initialSessionState,
  lastAssistantText,
  lastExecutionResult,
  renderExecutionOutput,
  type TurnEvent,
} from "./turn-event-model.ts";

test("tool lifecycle merges partial arguments, records final inputs and preserves unrelated state", () => {
  const initial = initialSessionState(null);
  const errors = [{ path: "input", message: "missing" }];
  const failed = applyTurnEvent(initial, { type: "validation_error", errors }, 1);
  const started = applyTurnEvent(
    failed,
    {
      type: "tool_call_start",
      call_id: "a",
      tool: "lookup",
      input_partial: { a: 1 },
      parent_message_id: "m",
    },
    2,
  );
  expect(started.status).toBe("running");
  expect(started.validationErrors).toEqual([]);
  expect(started.toolCalls).toEqual([
    { id: "a", name: "lookup", args: { a: 1 }, status: "running", parent_message_id: "m" },
  ]);
  const delta = applyTurnEvent(
    started,
    { type: "tool_call_delta", call_id: "a", input_patch: { a: 2, b: 3 } },
    3,
  );
  expect(delta.toolCalls[0]?.args).toEqual({ a: 2, b: 3 });
  expect(started.toolCalls[0]?.args).toEqual({ a: 1 });
  const ended = applyTurnEvent(
    delta,
    { type: "tool_call_end", call_id: "a", input: { final: true } },
    4,
  );
  expect(ended.toolCalls[0]?.args).toEqual({ final: true });
  for (const type of ["tool_call_delta", "tool_call_end"] as const) {
    const unchanged = applyTurnEvent(
      ended,
      type === "tool_call_delta"
        ? { type, call_id: "missing", input_patch: {} }
        : { type, call_id: "missing", input: {} },
      5,
    );
    expect(unchanged.toolCalls).toEqual(ended.toolCalls);
  }
  const empty = applyTurnEvent(
    initial,
    { type: "tool_call_start", call_id: "b", tool: "lookup" },
    2,
  );
  expect(
    applyTurnEvent(empty, { type: "tool_call_delta", call_id: "b", input_patch: { x: 1 } }, 3)
      .toolCalls[0]?.args,
  ).toEqual({ x: 1 });
  const result = applyTurnEvent(
    failed,
    {
      type: "tool_result",
      call_id: "orphan",
      tool: "lookup",
      output: { ok: false },
      parent_message_id: "m",
    },
    4,
  );
  expect(result.toolCalls).toEqual([
    {
      id: "orphan",
      name: "lookup",
      args: undefined,
      status: "failed",
      result: { ok: false },
      parent_message_id: "m",
    },
  ]);
  expect(result.validationErrors).toEqual(errors);
  const success = applyTurnEvent(
    result,
    { type: "tool_result", call_id: "orphan", tool: "lookup", output: 42 },
    5,
  );
  expect(success.toolCalls[0]?.status).toBe("done");
  expect(success.toolCalls[0]?.result).toBe(42);
  expect(success.validationErrors).toEqual([]);
  expect(initial.toolCalls).toEqual([]);
});

test("logs and data parts accumulate without changing their source collections", () => {
  const initial = initialSessionState(null);
  const event = {
    type: "tool_log",
    call_id: "a",
    tool: "lookup",
    level: "warn",
    message: "retry",
    ts: "instant",
  } as const;
  const logged = applyTurnEvent(initial, event, 1);
  expect(logged.toolLogs).toEqual([
    { call_id: "a", tool: "lookup", level: "warn", message: "retry", ts: "instant" },
  ]);
  const data = applyTurnEvent(logged, { type: "data_part", data_type: "rows", payload: [1, 2] }, 2);
  expect(data.dataParts).toEqual([{ data_type: "rows", payload: [1, 2] }]);
  expect(initial.toolLogs).toEqual([]);
  expect(logged.dataParts).toEqual([]);
  const activity = applyTurnEvent(
    data,
    {
      type: "activity",
      phase: "tool",
      label: "Looking",
      tool_name: "lookup",
      call_id: "a",
      last_completed: { tool_name: "previous", ok: false, duration_ms: 17 },
    },
    123,
  );
  expect(activity.activity).toEqual({
    phase: "tool",
    label: "Looking",
    tool_name: "lookup",
    call_id: "a",
    last_completed: { tool_name: "previous", ok: false, duration_ms: 17 },
    updated_at: 123,
  });
});

test("assistant text lookup skips later user messages and handles no assistant", () => {
  const initial = initialSessionState(null);
  expect(lastAssistantText(initial)).toBe("");
  const assistant = applyTurnEvent(
    initial,
    { type: "message", role: "assistant", content: "answer", id: "a" },
    1,
  );
  const user = applyTurnEvent(
    assistant,
    { type: "message", role: "user", content: "next", id: "u" },
    2,
  );
  expect(lastAssistantText(user)).toBe("answer");
});

test("execution output sampling is recursive and bounded without changing the output", () => {
  const output = { rows: [{ values: [1, 2, 3] }, 4, 5], flag: true };
  const before = structuredClone(output);
  expect(renderExecutionOutput({ tool: "query", output }, { maxArrayItems: 2 })).toBe(
    "[query] result:\n" +
      JSON.stringify(
        {
          rows: [{ values: [1, 2, "… sampled 2 of 3 items"] }, 4, "… sampled 2 of 3 items"],
          flag: true,
        },
        null,
        2,
      ),
  );
  expect(output).toEqual(before);
  expect(renderExecutionOutput({ tool: "query", output: "abcdef" }, { maxChars: 3 })).toBe(
    "[query] result:\nabc\n… [truncated 3 chars]",
  );
  expect(renderExecutionOutput({ tool: "query", output: undefined })).toBe(
    "[query] result:\nundefined",
  );
  expect(renderExecutionOutput({ tool: "query", output: 1n })).toBe("[query] result:\n1");
});

test("error frames restore pending input only for valid elicitation contracts", () => {
  for (const code of ["pending_elicitation_blocked", "elicitation_validation_failed"]) {
    const base: TurnEvent = {
      type: "validation_error",
      errors: [{ path: code, message: "blocked" }],
    };
    for (const pending of [
      undefined,
      null,
      2,
      {},
      { id: 1, tool_name: "ask" },
      { id: "e", tool_name: false },
    ]) {
      expect(
        errorFrameToEvents({ code, message: "blocked", details: { pending_elicitation: pending } }),
      ).toEqual([base]);
    }
    expect(
      errorFrameToEvents({
        code,
        message: "blocked",
        details: { pending_elicitation: { id: "e", tool_name: "ask", summary: 1 } },
      }),
    ).toEqual([
      base,
      { type: "elicit_request", elicitation_id: "e", tool_name: "ask", summary: "", input: {} },
    ]);
    expect(
      errorFrameToEvents({
        code,
        message: "blocked",
        details: {
          pending_elicitation: {
            id: "e",
            tool_name: "ask",
            summary: "Choose",
            input: false,
            tool_call_id: "c",
          },
        },
      }),
    ).toEqual([
      base,
      {
        type: "elicit_request",
        elicitation_id: "e",
        tool_name: "ask",
        summary: "Choose",
        input: false,
        tool_call_id: "c",
      },
    ]);
  }
  expect(errorFrameToEvents({ code: "other", message: "failure" })).toEqual([
    { type: "validation_error", errors: [{ path: "other", message: "failure" }] },
  ]);
});

test("diffs attach to the latest assistant and suggestions replace or clear prior proposals", () => {
  const initial = initialSessionState(null);
  const assistant = applyTurnEvent(
    initial,
    { type: "message", role: "assistant", content: "answer", id: "a" },
    1,
  );
  const user = applyTurnEvent(
    assistant,
    { type: "message", role: "user", content: "next", id: "u" },
    2,
  );
  const diff = applyTurnEvent(
    user,
    { type: "diff", title: "Change", language: "json", hunks: [{ kind: "+", text: "added" }] },
    77,
  );
  expect(diff.diffs).toEqual([
    {
      id: "diff-0-77",
      title: "Change",
      language: "json",
      hunks: [{ kind: "+", text: "added" }],
      parentMessageId: "a",
    },
  ]);
  const proposed = applyTurnEvent(
    diff,
    { type: "next_suggestion", suggestion: "/run", kind: "slash", reason: "model" },
    3,
  );
  expect(proposed.nextSuggestion).toEqual({ suggestion: "/run", kind: "slash" });
  expect(proposed.nextSuggestionReason).toBe("model");
  for (const [suggestion, kind] of [
    [null, "text"],
    ["text", null],
    ["", "text"],
  ] as const) {
    const cleared = applyTurnEvent(
      proposed,
      { type: "next_suggestion", suggestion, kind, reason: "filtered" },
      4,
    );
    expect(cleared.nextSuggestion).toBeNull();
    expect(cleared.nextSuggestionReason).toBe("filtered");
  }
  const pending = applyTurnEvent(
    initial,
    {
      type: "elicit_request",
      elicitation_id: "e",
      tool_name: "ask",
      summary: "confirm",
      input: {},
    },
    5,
  );
  const committed = applyTurnEvent(pending, { type: "committed", workflow_id: "w" }, 6);
  expect(committed.committedWorkflowId).toBe("w");
  expect(committed.pendingElicitation).toBeNull();
  expect(pending.pendingElicitation?.id).toBe("e");
});

test("primitive execution results remain visible and unknown stream frames preserve state", () => {
  const initial = initialSessionState(null);
  for (const output of [false, 0, "result"]) {
    const state = applyTurnEvent(
      initial,
      { type: "tool_result", call_id: "r", tool: "run_workflow", output },
      1,
    );
    expect(lastExecutionResult(state)).toEqual({ tool: "run_workflow", output });
  }
  const futureFrame = JSON.parse('{"type":"future_protocol_event"}') as TurnEvent;
  expect(applyTurnEvent(initial, futureFrame, 1)).toBe(initial);
});
