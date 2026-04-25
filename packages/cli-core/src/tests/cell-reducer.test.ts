// Cell-based reducer behaviour. Walks every TurnEvent variant + the
// chronological-ordering invariants the cell model exists to enforce.

import { describe, expect, test } from "bun:test";
import {
  applyTurnEventToCells,
  type CellState,
  type CellTurnEvent,
  initialCellState,
} from "../transcript-cell.ts";

function reduce(events: CellTurnEvent[], seed?: CellState): CellState {
  let state = seed ?? initialCellState();
  for (const ev of events) state = applyTurnEventToCells(state, ev);
  return state;
}

describe("cell reducer — chronological invariants", () => {
  test("user message lands as the earliest cell of the turn", () => {
    const state = reduce([{ type: "message", role: "user", content: "hello", id: "m-user-1" }]);
    expect(state.cells).toHaveLength(1);
    expect(state.cells[0]!.kind).toBe("user");
    expect(state.cells[0]!.id).toBe("m-user-1");
  });

  test("text_delta creates an active streaming AssistantCell", () => {
    const state = reduce([{ type: "text_delta", text: "hel" }]);
    expect(state.cells).toHaveLength(0);
    expect(state.active).not.toBeNull();
    expect(state.active!.kind).toBe("assistant");
    expect((state.active as { text: string }).text).toBe("hel");
    expect((state.active as { streaming: boolean }).streaming).toBe(true);
  });

  test("text_delta then message role=assistant finalizes the streaming cell", () => {
    const state = reduce([
      { type: "message", role: "user", content: "hi", id: "m-user-1" },
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
      { type: "message", role: "assistant", content: "hello!", id: "m-assist-1" },
    ]);
    expect(state.active).toBeNull();
    expect(state.cells).toHaveLength(2);
    expect(state.cells[1]!.kind).toBe("assistant");
    expect(state.cells[1]!.id).toBe("m-assist-1");
    expect((state.cells[1] as { text: string }).text).toBe("hello!");
  });

  test("tool_call_start finalizes any streaming AssistantCell first (causal order)", () => {
    const state = reduce([
      { type: "message", role: "user", content: "do thing", id: "m-user-1" },
      { type: "text_delta", text: "let me think" },
      { type: "tool_call_start", call_id: "c-1", tool: "search_docs" },
    ]);
    // user, assistant (finalized after start), then active = tool
    expect(state.cells).toHaveLength(2);
    expect(state.cells[1]!.kind).toBe("assistant");
    expect(state.active).not.toBeNull();
    expect(state.active!.kind).toBe("tool");
    expect((state.active as { name: string }).name).toBe("search_docs");
  });

  test("tool_result with ok:false synthesizes a trailing ErrorCell", () => {
    const state = reduce([
      { type: "message", role: "user", content: "go", id: "m-user-1" },
      { type: "tool_call_start", call_id: "c-1", tool: "probe" },
      {
        type: "tool_result",
        call_id: "c-1",
        tool: "probe",
        output: { ok: false, error: "timeout" },
      },
    ]);
    const kinds = state.cells.map((c) => c.kind);
    expect(kinds).toEqual(["user", "tool", "error"]);
    const tool = state.cells[1] as { status: string };
    expect(tool.status).toBe("failed");
    const err = state.cells[2] as { origin: string; message: string };
    expect(err.origin).toBe("tool");
    expect(err.message).toContain("timeout");
  });

  test("tool_log appends to matching ToolCell.logs", () => {
    const state = reduce([
      { type: "tool_call_start", call_id: "c-1", tool: "probe" },
      {
        type: "tool_log",
        call_id: "c-1",
        tool: "probe",
        level: "info",
        message: "fetching",
        ts: "2026-04-25T10:00:00Z",
      },
    ]);
    expect(state.active).not.toBeNull();
    const tool = state.active as { logs: Array<{ message: string }> };
    expect(tool.logs).toHaveLength(1);
    expect(tool.logs[0]!.message).toBe("fetching");
  });

  test("validation_error pushes an ErrorCell per error", () => {
    const state = reduce([
      {
        type: "validation_error",
        errors: [
          { path: "steps.0.kind", message: "Invalid input" },
          { path: "steps.1.field", message: "Expected string" },
        ],
      },
    ]);
    expect(state.cells).toHaveLength(2);
    expect(state.cells.every((c) => c.kind === "error")).toBe(true);
    expect(state.status).toBe("error");
  });

  test("elicit_request pushes ElicitationCell + sets pendingElicitation", () => {
    const state = reduce([
      { type: "message", role: "assistant", content: "ok?", id: "m-a-1" },
      {
        type: "elicit_request",
        elicitation_id: "el-1",
        tool_name: "ask_user_confirm",
        summary: "approve?",
        input: { kind: "yes_no" },
      },
    ]);
    expect(state.status).toBe("awaiting_input");
    expect(state.pendingElicitation?.id).toBe("el-1");
    const last = state.cells[state.cells.length - 1] as { kind: string; status: string };
    expect(last.kind).toBe("elicit");
    expect(last.status).toBe("open");
  });

  test("committed pushes a SystemCell announcing the workflow id", () => {
    const state = reduce([{ type: "committed", workflow_id: "wf-42" }]);
    const last = state.cells[state.cells.length - 1] as { kind: string; message: string };
    expect(last.kind).toBe("system");
    expect(last.message).toContain("wf-42");
    expect(state.committedWorkflowId).toBe("wf-42");
  });

  test("completed flushes active and updates usage", () => {
    const state = reduce([
      { type: "text_delta", text: "partial" },
      {
        type: "completed",
        status: "completed",
        usage: { turn_tokens: 42, remaining_monthly_budget_tokens: 100 },
      },
    ]);
    expect(state.active).toBeNull();
    expect(state.cells).toHaveLength(1);
    expect(state.cells[0]!.kind).toBe("assistant");
    expect(state.usage?.turn_tokens).toBe(42);
    expect(state.status).toBe("completed");
  });

  test("__sse_parse_error pushes ErrorCell{origin:'sse'}", () => {
    const state = reduce([
      {
        type: "__sse_parse_error",
        raw: "data: {bad",
        reason: "Unexpected token",
      },
    ]);
    expect(state.cells).toHaveLength(1);
    const err = state.cells[0] as { kind: string; origin: string };
    expect(err.kind).toBe("error");
    expect(err.origin).toBe("sse");
  });

  test("AssistantCell.toolRefs links to the ToolCell that follows", () => {
    const state = reduce([
      { type: "text_delta", text: "thinking" },
      { type: "tool_call_start", call_id: "c-1", tool: "search_docs" },
      {
        type: "tool_result",
        call_id: "c-1",
        tool: "search_docs",
        output: { ok: true },
      },
    ]);
    const assistant = state.cells.find((c) => c.kind === "assistant") as
      | { toolRefs: string[] }
      | undefined;
    expect(assistant).not.toBeUndefined();
    expect(assistant!.toolRefs).toContain("c-1");
  });

  test("trace id from state.currentTraceId is attached to new cells", () => {
    let state = initialCellState();
    state = { ...state, currentTraceId: "trace-xyz" };
    state = applyTurnEventToCells(state, {
      type: "message",
      role: "user",
      content: "hi",
      id: "m-u-1",
    });
    expect(state.cells[0]!.traceId).toBe("trace-xyz");
  });
});
