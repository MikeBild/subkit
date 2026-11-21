import { describe, expect, test } from "bun:test";
import { dedupeBackground, groupMessageParts } from "./transcript";

const call = (callId: string, tool: string) => ({
  type: "tool_call",
  call_id: callId,
  tool,
  input: {},
});
const result = (callId: string, output: unknown, extra: Record<string, unknown> = {}) => ({
  type: "tool_result",
  call_id: callId,
  output,
  ...extra,
});

describe("groupMessageParts", () => {
  test("collapses a run of consecutive reads into one background group", () => {
    const groups = groupMessageParts([
      call("a", "list_workflows"),
      result("a", { items: [] }),
      call("b", "get_workflow"),
      result("b", { id: "x" }),
      call("c", "run_workflow"),
      result("c", { ok: true }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["background", "tool"]);
    const background = groups[0];
    if (background?.kind !== "background") throw new Error("expected a background group");
    expect(background.tools).toHaveLength(2);
  });

  test("keeps order — a read after a write does not join the earlier run", () => {
    const groups = groupMessageParts([
      call("a", "list_workflows"),
      call("b", "run_workflow"),
      call("c", "get_workflow"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["background", "tool", "background"]);
  });

  test("passes text parts through untouched and never renders a bare result", () => {
    const groups = groupMessageParts([
      { type: "text", text: "hello" },
      call("a", "run_workflow"),
      result("a", { ok: true }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["part", "tool"]);
  });

  test("an unregistered tool gets a card rather than disappearing into a line", () => {
    const groups = groupMessageParts([call("a", "some_future_tool")]);
    expect(groups.map((g) => g.kind)).toEqual(["tool"]);
  });

  test("a result without an output leaves the call running, not completed", () => {
    const groups = groupMessageParts([call("a", "run_workflow"), result("a", null)]);
    const only = groups[0];
    if (only?.kind !== "tool") throw new Error("expected a tool group");
    expect(only.tool.state).toBe("input-available");
  });

  test("an outcome of error surfaces as an error state, not a success", () => {
    const groups = groupMessageParts([
      call("a", "run_workflow"),
      result("a", { rows: [] }, { outcome: "error" }),
    ]);
    const only = groups[0];
    if (only?.kind !== "tool") throw new Error("expected a tool group");
    expect(only.tool.state).toBe("output-error");
  });
});

describe("dedupeBackground", () => {
  test("counts repeats of one action instead of repeating its line", () => {
    const groups = groupMessageParts([
      call("a", "get_workflow"),
      result("a", { id: "1" }),
      call("b", "get_workflow"),
      result("b", { id: "2" }),
      call("c", "list_connectors"),
      result("c", { items: [] }),
    ]);
    const background = groups[0];
    if (background?.kind !== "background") throw new Error("expected a background group");
    const lines = dedupeBackground(background.tools);
    expect(lines).toEqual([
      { toolName: "get_workflow", count: 2, running: false },
      { toolName: "list_connectors", count: 1, running: false },
    ]);
  });

  test("a line is running while any of the calls it stands for still is", () => {
    const groups = groupMessageParts([
      call("a", "get_workflow"),
      result("a", { id: "1" }),
      call("b", "get_workflow"),
    ]);
    const background = groups[0];
    if (background?.kind !== "background") throw new Error("expected a background group");
    expect(dedupeBackground(background.tools)[0]?.running).toBe(true);
  });
});
