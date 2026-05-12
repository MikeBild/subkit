// transform-authoring-gate — pure unit tests for the inspect-before-
// transform gate. No DB; the gate reads workflow.steps +
// latest_preview.step_traces and emits typed blocks when a transform
// reads `$scope.<X>` without a recorded preview for X.

import { describe, expect, test } from "bun:test";
import type { WorkflowDraftStepPreview } from "../../types.ts";
import { evaluateTransformAuthoringGate } from "../transform-authoring-gate.ts";

const traceFor = (step_id: string, output_preview?: unknown): WorkflowDraftStepPreview => ({
  step_id,
  kind: "request",
  status: "succeeded",
  ...(output_preview !== undefined ? { output_preview } : {}),
});

describe("evaluateTransformAuthoringGate", () => {
  test("ok when there are no transform steps", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "a", kind: "request" },
          { id: "b", kind: "request" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  test("ok when the transform reads only $input (no $scope refs)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "shape", kind: "transform", expression: "{ id: $input.x, n: $count($input.xs) }" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("blocks transform when no dry-run has been recorded yet", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "$scope.fetch.data.items.{name: $.name}",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_dry_run_yet");
    expect(result.blocks[0]?.transform_step_id).toBe("format");
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });

  test("blocks transform when the referenced step has no recorded preview", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "other", kind: "request" },
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "$scope.fetch.data.items",
          },
        ],
      },
      {
        ok: true,
        summary: "ok",
        // only `other` has a recorded preview; `fetch` does not
        step_traces: [traceFor("other", { something: 1 })],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_preview_for_referenced_step");
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });

  test("ok when the referenced step has a recorded output_preview", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "$scope.fetch.data.items",
          },
        ],
      },
      {
        ok: true,
        summary: "ok",
        step_traces: [traceFor("fetch", { items: [{ id: 1, name: "a" }] })],
      },
    );
    expect(result.ok).toBe(true);
  });

  test("skips self-references (a transform reading its own output)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "format",
            kind: "transform",
            expression: "$scope.format.data",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("does not flag references to step ids that aren't in the workflow", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "format",
            kind: "transform",
            expression: "$scope.unknown.data",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("flags transforms patched onto an empty-output step", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "$scope.fetch.data",
          },
        ],
      },
      {
        ok: true,
        summary: "ok",
        // trace exists but output_preview is null
        step_traces: [{ ...traceFor("fetch"), output_preview: null }],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_preview_for_referenced_step");
  });
});
