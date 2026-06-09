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

  // Control-flow exemption — loop/branch/parallel steps and their
  // body/then/branch children have no recordable standalone preview (a
  // loop's children run inside the iteration and are skipped in the
  // linear walk; a 0-row loop never runs its body; a non-taken branch
  // arm never runs). Blocking a transform that reads them is an
  // unsatisfiable gate. Regression guard for the publish-ready-essays
  // deadlock: a post-loop summary transform could never be authored
  // because the loop produced 0 rows and thus no preview, ever.
  test("exempts a transform that reads a loop step's aggregated output (no dry-run)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "query", kind: "request" },
          {
            id: "publish_loop",
            kind: "loop",
            over: "$scope.query.data.results",
            body: ["publish_one"],
          },
          { id: "publish_one", kind: "call", workflow_slug: "x" },
          {
            id: "summarize",
            kind: "transform",
            expression: "{ n: $count($scope.publish_loop.data.publish_one.data) }",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  test("exempts a transform that reads a loop BODY child step directly", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "publish_loop",
            kind: "loop",
            over: "$scope.q.data",
            body: ["publish_one", "mark"],
          },
          { id: "publish_one", kind: "call", workflow_slug: "x" },
          { id: "mark", kind: "request" },
          { id: "summarize", kind: "transform", expression: "$scope.publish_one.data.output" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("exempts a transform that reads a branch then/else child step", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "decide",
            kind: "branch",
            when: "$x > 0",
            then_steps: ["fmt"],
            else_steps: ["fallback"],
          },
          { id: "fmt", kind: "transform", expression: "{ a: 1 }" },
          { id: "fallback", kind: "request" },
          {
            id: "consumer",
            kind: "transform",
            expression: "$scope.fmt.data & $scope.fallback.data",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("exempts a transform that reads a parallel branch child or the parallel step itself", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "par", kind: "parallel", branches: [["w1"], ["w2"]] },
          { id: "w1", kind: "request" },
          { id: "w2", kind: "request" },
          {
            id: "join",
            kind: "transform",
            expression: "{ a: $scope.par.data, b: $scope.w1.data }",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("still blocks a transform that reads a plain request sibling with no preview (regression)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "$scope.fetch.data.items" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });

  // Runtime/data-failure exemption. A transform whose referenced sibling
  // dry-ran but died on a 404/410/403/401 (runtime/data error) has no
  // output_preview because the request never returned a body — gating on it
  // would freeze the authoring loop forever (the draft is structurally
  // sound; only the remote test fixture failed). Same spirit as the
  // control-flow exemption.
  test("exempts a transform whose referenced step failed with a 404 runtime error", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "$scope.fetch.data.items" },
        ],
      },
      {
        ok: false,
        summary: "failed",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "failed",
            request_meta: { status: 404 },
            // No output_preview — the request returned 404
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(0);
  });

  test("exempts a transform whose referenced step failed with a 410 Gone runtime error", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "$scope.fetch.data.items" },
        ],
      },
      {
        ok: false,
        summary: "failed",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "error",
            request_meta: { status: 410 },
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(0);
  });

  test("still blocks a transform if the referenced step failed with a config-invalid error (not runtime)", () => {
    // An unresolved_identifier error means the draft itself is wrong —
    // the exemption must NOT fire for config-invalid failures.
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "$scope.fetch.data.items" },
        ],
      },
      {
        ok: false,
        summary: "failed",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "error",
            error_code: "unresolved_identifier",
          },
        ],
      },
    );
    // The referenced step's failure is not a runtime/data error — gate holds.
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });
});
