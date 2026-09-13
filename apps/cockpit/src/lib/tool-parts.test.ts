import { describe, expect, test } from "bun:test";

import { asToolPart, patchCandidateId, withToolResult } from "./tool-parts";

describe("tool part adapter", () => {
  test("keeps a streamed part untouched", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "run_workflow",
      toolCallId: "c1",
      state: "output-available",
    };
    expect(asToolPart(part)).toBe(part as never);
  });

  test("renders a persisted tool call that would otherwise be dropped", () => {
    const tool = asToolPart({
      type: "tool_call",
      call_id: "c1",
      tool: "approve_patch_candidate",
      input: { candidate_id: "pc-1" },
      phase: "result",
    });
    expect(tool?.type).toBe("dynamic-tool");
    expect(tool?.toolCallId).toBe("c1");
    expect(tool?.state).toBe("input-available");
  });

  test("marks the call the conversation is waiting on as awaiting a decision", () => {
    const tool = asToolPart(
      { type: "tool_call", call_id: "c1", tool: "approve_patch_candidate", input: {} },
      "c1",
    );
    expect(tool?.state).toBe("approval-requested");
    expect(tool?.approval?.id).toBe("c1");
  });

  test("ignores text parts and malformed calls", () => {
    expect(asToolPart({ type: "text", text: "hello" })).toBeNull();
    expect(asToolPart({ type: "tool_call", tool: "x" })).toBeNull();
    expect(asToolPart(null)).toBeNull();
  });

  test("merges a result into its call but never over a pending decision", () => {
    const parts = [
      { type: "tool_call", call_id: "c1", tool: "run_workflow", input: {} },
      { type: "tool_result", call_id: "c1", tool: "run_workflow", output: { ok: true } },
    ];
    const merged = withToolResult(asToolPart(parts[0]) as never, parts);
    expect(merged.state).toBe("output-available");
    expect(merged.output).toEqual({ ok: true });

    const pending = withToolResult(asToolPart(parts[0], "c1") as never, parts);
    expect(pending.state).toBe("approval-requested");
  });

  test("reads the patch candidate only from patch tools", () => {
    const patch = asToolPart({
      type: "tool_call",
      call_id: "c1",
      tool: "approve_patch_candidate",
      input: { candidate_id: "pc-1" },
    });
    expect(patchCandidateId(patch as never)).toBe("pc-1");

    const other = asToolPart({
      type: "tool_call",
      call_id: "c2",
      tool: "run_workflow",
      input: { candidate_id: "pc-1" },
    });
    expect(patchCandidateId(other as never)).toBeNull();
  });
});
