// dag.ts now reads bare-path step references when the leading
// identifier matches a known step id. This pins the cycle-detection
// behaviour so a forward-ref via the bare form still produces an
// edge.

import { describe, expect, test } from "bun:test";
import { buildStepDag, detectCycles } from "../dag.ts";
import type { WorkflowDef } from "../types.ts";

function wf(steps: WorkflowDef["steps"]): WorkflowDef {
  return { name: "t", steps };
}

describe("dag · bare-path edges", () => {
  test("bare-path reference adds a jsonata_bare edge", () => {
    const dag = buildStepDag(
      wf([
        { id: "fetch", kind: "request", method: "GET", url: "https://x/y" },
        {
          id: "shape",
          kind: "transform",
          // bare path, not $scope
          expression: "fetch.data.id",
        },
      ]),
    );
    const edge = dag.edges.find((e) => e.from === "shape" && e.to === "fetch");
    expect(edge?.reason).toBe("jsonata_bare");
  });

  test("cycle via bare-path forward refs is detected", () => {
    const dag = buildStepDag(
      wf([
        // a references b via bare path; b references a via $scope
        { id: "a", kind: "transform", expression: "b.data" },
        { id: "b", kind: "transform", expression: "$scope.a.data" },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.has_cycle).toBe(true);
    expect(new Set(report.cycles[0]?.nodes ?? [])).toEqual(new Set(["a", "b"]));
  });

  test("bare-path reference to an UNKNOWN step id does NOT add an edge", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "shape",
          kind: "transform",
          expression: "totally_made_up.data",
        },
      ]),
    );
    expect(dag.edges).toEqual([]);
  });
});
