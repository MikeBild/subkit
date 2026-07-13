// `repairToolCall` missing-tool rewrite tests.
//
// Focus on the unknown-tool branch, which never reaches the LLM: it
// decides purely from the tool name + which execution targets the
// palette carries. The two-target rewrite keeps the draft-run path
// reachable when the execution-tool gate has stripped `run_workflow`
// and the `wf_<slug>` peers from an authoring conversation, so the
// model's "test the draft I just built" call lands on
// `dry_run_workflow` instead of dead-ending in the repair cap.

import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { repairToolCall } from "./repair-tool-call.ts";

// The missing-tool branch never touches the model, so a bare sentinel
// suffices — if any test reaches `generateObject` it will throw and the
// test fails loudly rather than silently passing.
const UNUSED_MODEL = {} as unknown as LanguageModel;

function noSuchToolError(toolName: string) {
  const err = new Error(`No such tool: ${toolName}`);
  err.name = "AI_NoSuchToolError";
  // biome-ignore lint/suspicious/noExplicitAny: minimal NoSuchToolError stand-in.
  return err as any;
}

// A minimal Tool stand-in — presence (truthiness) is all the rewrite
// branch checks for the target tools.
const STUB_TOOL = { description: "stub" } as const;

describe("repairToolCall — missing-tool draft-run rewrite", () => {
  test("wf_<slug> with dry_run_workflow but NOT run_workflow → dry_run_workflow carrying original args as .input", async () => {
    let repairFired = false;
    const result = await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "wf_render_upload_slides",
        input: JSON.stringify({ deck: "q3", pages: 12 }),
      },
      tools: { dry_run_workflow: STUB_TOOL } as never,
      messages: [],
      system: "",
      error: noSuchToolError("wf_render_upload_slides"),
      model: UNUSED_MODEL,
      onRepair: () => {
        repairFired = true;
      },
    });

    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("dry_run_workflow");
    const parsed = JSON.parse(result!.input as string);
    expect(parsed).toEqual({ input: { deck: "q3", pages: 12 } });
    expect(repairFired).toBe(true);
  });

  test("bare run_workflow unknown + dry_run_workflow present → same dry_run_workflow rewrite", async () => {
    let repairFired = false;
    const result = await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "run_workflow",
        input: JSON.stringify({ workflow: "draft", input: { foo: 1 } }),
      },
      tools: { dry_run_workflow: STUB_TOOL } as never,
      messages: [],
      system: "",
      error: noSuchToolError("run_workflow"),
      model: UNUSED_MODEL,
      onRepair: () => {
        repairFired = true;
      },
    });

    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("dry_run_workflow");
    const parsed = JSON.parse(result!.input as string);
    expect(parsed).toEqual({ input: { workflow: "draft", input: { foo: 1 } } });
    expect(repairFired).toBe(true);
  });

  test("wf_<slug> with run_workflow present → existing run_workflow rewrite (precedence)", async () => {
    let repairFired = false;
    const result = await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_3",
        toolName: "wf_acme_report",
        input: JSON.stringify({ month: "june" }),
      },
      // Both targets present: run_workflow wins for wf_<slug>.
      tools: { run_workflow: STUB_TOOL, dry_run_workflow: STUB_TOOL } as never,
      messages: [],
      system: "",
      error: noSuchToolError("wf_acme_report"),
      model: UNUSED_MODEL,
      onRepair: () => {
        repairFired = true;
      },
    });

    expect(result?.toolName).toBe("run_workflow");
    const parsed = JSON.parse(result!.input as string);
    expect(parsed.workflow).toBe("acme-report");
    expect(repairFired).toBe(true);
  });

  test("neither run_workflow nor dry_run_workflow nor find_workflow present → null (unknown_tool, existing behavior)", async () => {
    let repairFired = false;
    const result = await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_4",
        toolName: "wf_render_upload_slides",
        input: JSON.stringify({ deck: "q3" }),
      },
      tools: {} as never,
      messages: [],
      system: "",
      error: noSuchToolError("wf_render_upload_slides"),
      model: UNUSED_MODEL,
      onRepair: () => {
        repairFired = true;
      },
    });

    expect(result).toBeNull();
    expect(repairFired).toBe(false);
  });

  test("wf_<slug> with only find_workflow present → find_workflow query from the slug (chat discover-then-run)", async () => {
    let repairFired = false;
    const result = await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_5",
        toolName: "wf_berlin_weather_tomorrow",
        input: JSON.stringify({}),
      },
      tools: { find_workflow: STUB_TOOL } as never,
      messages: [],
      system: "",
      error: noSuchToolError("wf_berlin_weather_tomorrow"),
      model: UNUSED_MODEL,
      onRepair: () => {
        repairFired = true;
      },
    });

    expect(result?.toolName).toBe("find_workflow");
    expect(JSON.parse(result!.input as string).query).toBe("berlin weather tomorrow");
    expect(repairFired).toBe(true);
  });

  test("bare run_workflow with a workflow slug + only find_workflow → find_workflow query from that slug", async () => {
    const result = await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_6",
        toolName: "run_workflow",
        input: JSON.stringify({ workflow: "berlin-weather-by-date" }),
      },
      tools: { find_workflow: STUB_TOOL } as never,
      messages: [],
      system: "",
      error: noSuchToolError("run_workflow"),
      model: UNUSED_MODEL,
    });

    expect(result?.toolName).toBe("find_workflow");
    expect(JSON.parse(result!.input as string).query).toBe("berlin weather by date");
  });

  test("bare run_workflow with NO slug + only find_workflow → null (nothing to search on)", async () => {
    const result = await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_7",
        toolName: "run_workflow",
        input: JSON.stringify({}),
      },
      tools: { find_workflow: STUB_TOOL } as never,
      messages: [],
      system: "",
      error: noSuchToolError("run_workflow"),
      model: UNUSED_MODEL,
    });

    expect(result).toBeNull();
  });
});
