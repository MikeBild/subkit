// loop-authoring-gate — pure unit tests for the inspect-before-loop
// gate. No DB; the gate reads workflow.steps + latest_preview.step_traces
// and emits typed blocks when a loop reads `$scope.<X>` without a
// recorded preview for X.

import { describe, expect, test } from "bun:test";

import type { WorkflowDraftStepPreview } from "../../types.ts";
import { evaluateLoopAuthoringGate } from "../loop-authoring-gate.ts";

const traceFor = (
  step_id: string,
  scope?: WorkflowDraftStepPreview["scope_at_step"],
): WorkflowDraftStepPreview => ({
  step_id,
  kind: "request",
  status: "succeeded",
  ...(scope ? { scope_at_step: scope } : {}),
});

describe("evaluateLoopAuthoringGate", () => {
  test("ok when there's no loop step", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          { id: "a", kind: "request" },
          { id: "b", kind: "transform", expression: "$scope.a.data" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  test("blocks loop when no preview has been recorded yet", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: [] },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_dry_run_yet");
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
    expect(result.blocks[0]?.loop_step_id).toBe("iter");
  });

  test("blocks loop when the upstream step has no recorded preview", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          { id: "other", kind: "request" },
          { id: "fetch", kind: "request" },
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: [] },
        ],
      },
      {
        ok: true,
        summary: "x",
        step_traces: [
          traceFor("other", {
            available_paths: ["data"],
            shape_summary: "object{data}",
            primary_data_path: "data",
          }),
        ],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_preview_for_referenced_step");
  });

  test("blocks loop when the preview exists but lacks scope_at_step", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: [] },
        ],
      },
      {
        ok: true,
        summary: "x",
        step_traces: [traceFor("fetch")],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("preview_missing_scope");
  });

  test("passes when the preview has a populated scope_at_step", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: [] },
        ],
      },
      {
        ok: true,
        summary: "x",
        step_traces: [
          traceFor("fetch", {
            available_paths: ["data", "data.items", "data.items[*]"],
            shape_summary: "object{data}",
            primary_data_path: "data.items",
          }),
        ],
      },
    );
    expect(result.ok).toBe(true);
  });

  test("ignores references to unknown step ids (already caught earlier)", () => {
    // referenceValidateStep flags unknown ids; the loop gate only
    // covers references that point at actual sibling steps in this
    // draft. Otherwise we'd double-report.
    const result = evaluateLoopAuthoringGate(
      {
        steps: [{ id: "iter", kind: "loop", over: "$scope.does_not_exist.data", body: [] }],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("inspects loop.data_selector (JS expression form) too", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          {
            id: "iter",
            kind: "loop",
            data_selector: "(scope) => scope.$scope.fetch.data",
            body: [],
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });
});
