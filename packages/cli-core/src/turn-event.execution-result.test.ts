import { describe, expect, test } from "bun:test";
import {
  initialSessionState,
  lastExecutionResult,
  renderExecutionOutput,
  type SkSessionState,
  type ToolCallState,
} from "./turn-event.ts";

function stateWith(calls: ToolCallState[]): SkSessionState {
  return { ...initialSessionState("c1"), toolCalls: calls };
}

function call(partial: Partial<ToolCallState> & { name: string }): ToolCallState {
  return { id: partial.id ?? "t1", args: {}, status: "done", ...partial };
}

describe("lastExecutionResult", () => {
  test("returns the last succeeded run_workflow data payload", () => {
    const state = stateWith([
      call({ id: "a", name: "run_workflow", result: { ok: true, data: { repos: [1, 2] } } }),
    ]);
    expect(lastExecutionResult(state)).toEqual({
      tool: "run_workflow",
      output: { repos: [1, 2] },
    });
  });

  test("wf_<slug> per-workflow tools match", () => {
    const state = stateWith([
      call({ name: "wf_org_top_repos", result: { ok: true, data: { total: 95 } } }),
    ]);
    expect(lastExecutionResult(state)?.tool).toBe("wf_org_top_repos");
  });

  test("failed calls and ok:false envelopes never match", () => {
    const state = stateWith([
      call({ id: "a", name: "run_workflow", status: "failed", error: "boom" }),
      call({ id: "b", name: "run_workflow", result: { ok: false, data: { repos: [] } } }),
    ]);
    expect(lastExecutionResult(state)).toBeNull();
  });

  test("non-execution tools never match", () => {
    const state = stateWith([
      call({ name: "list_workflows", result: { ok: true, data: { workflows: [] } } }),
    ]);
    expect(lastExecutionResult(state)).toBeNull();
  });

  test("picks the LAST succeeded execution when several ran", () => {
    const state = stateWith([
      call({ id: "a", name: "run_workflow", result: { ok: true, data: "first" } }),
      call({ id: "b", name: "run_workflow", result: { ok: true, data: "second" } }),
    ]);
    expect(lastExecutionResult(state)?.output).toBe("second");
  });
});

describe("renderExecutionOutput", () => {
  test("headers with the tool name and pretty-prints the payload", () => {
    const text = renderExecutionOutput({ tool: "run_workflow", output: { n: 1 } });
    expect(text).toContain("[run_workflow] result:");
    expect(text).toContain('"n": 1');
  });

  test("samples long arrays with an explicit in-band marker", () => {
    const output = { items: Array.from({ length: 50 }, (_, i) => i) };
    const text = renderExecutionOutput({ tool: "wf_x", output }, { maxArrayItems: 5 });
    expect(text).toContain("sampled 5 of 50 items");
    expect(text).not.toContain("49");
  });

  test("hard-caps the body with a truncation marker", () => {
    const text = renderExecutionOutput(
      { tool: "wf_x", output: "y".repeat(5000) },
      { maxChars: 100 },
    );
    expect(text.length).toBeLessThan(220);
    expect(text).toContain("[truncated");
  });
});
