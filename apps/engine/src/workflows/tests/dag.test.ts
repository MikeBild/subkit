// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// Step dependency DAG — unit tests for buildStepDag, detectCycles,
// topoSort, and renderCycleReport. Pure data, no I/O.

import { describe, expect, test } from "bun:test";
import { buildStepDag, detectCycles, renderCycleReport, topoSort } from "../dag.ts";
import type { WorkflowDef } from "../types.ts";

function wf(steps: WorkflowDef["steps"]): WorkflowDef {
  return { name: "t", steps };
}

describe("buildStepDag", () => {
  test("linear workflow with no refs has zero edges", () => {
    const dag = buildStepDag(
      wf([
        { id: "a", kind: "transform", language: "javascript", expression: "return input.input;" },
        { id: "b", kind: "transform", language: "javascript", expression: "return 1;" },
      ]),
    );
    expect(dag.step_ids).toEqual(["a", "b"]);
    expect(dag.edges).toEqual([]);
  });

  test("scope-placeholder reference adds a data-flow edge", () => {
    const dag = buildStepDag(
      wf([
        { id: "a", kind: "transform", language: "javascript", expression: "return input.input;" },
        {
          id: "b",
          kind: "request",
          method: "GET",
          url: "https://example.com/${scope.a.data.id}",
        },
      ]),
    );
    const edge = dag.edges.find((e) => e.from === "b" && e.to === "a");
    expect(edge?.reason).toBe("scope_placeholder");
  });

  test("JSONata $scope reference in a branch.when adds a data-flow edge", () => {
    // JSONata survives in the branch.when slot; `$scope.a.data` there still
    // produces a `jsonata_scope` edge.
    const dag = buildStepDag(
      wf([
        { id: "a", kind: "transform", language: "javascript", expression: "return input.input;" },
        { id: "b", kind: "branch", when: "$scope.a.data", then_steps: ["a"] },
      ]),
    );
    const edge = dag.edges.find(
      (e) => e.from === "b" && e.to === "a" && e.reason === "jsonata_scope",
    );
    expect(edge?.reason).toBe("jsonata_scope");
  });

  test("JS scope reference in a transform adds a data-flow edge", () => {
    const dag = buildStepDag(
      wf([
        { id: "a", kind: "transform", language: "javascript", expression: "return input.input;" },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    const edge = dag.edges.find((e) => e.from === "b" && e.to === "a");
    expect(edge?.reason).toBe("js_scope");
  });

  test("branch arms create containment edges (arm depends on branch)", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "router",
          kind: "branch",
          when: "true",
          then_steps: ["yes"],
          else_steps: ["no"],
        },
        { id: "yes", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "no", kind: "transform", language: "javascript", expression: "return 0;" },
      ]),
    );
    expect(dag.edges).toContainEqual({
      from: "yes",
      to: "router",
      reason: "branch_arm",
    });
    expect(dag.edges).toContainEqual({
      from: "no",
      to: "router",
      reason: "branch_arm",
    });
  });

  test("parallel branches create containment edges", () => {
    const dag = buildStepDag(
      wf([
        { id: "fan", kind: "parallel", branches: [["a"], ["b"]] },
        { id: "a", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "b", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    expect(dag.edges).toContainEqual({ from: "a", to: "fan", reason: "parallel_branch" });
    expect(dag.edges).toContainEqual({ from: "b", to: "fan", reason: "parallel_branch" });
  });

  test("loop body steps depend on the loop step", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "iter",
          kind: "loop",
          over: "$input",
          item_var: "x",
          body: ["work"],
        },
        { id: "work", kind: "transform", language: "javascript", expression: "return 1;" },
      ]),
    );
    expect(dag.edges).toContainEqual({ from: "work", to: "iter", reason: "loop_body" });
  });

  test("references to unknown step ids are dropped silently", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.nonexistent.data;",
        },
      ]),
    );
    expect(dag.edges).toEqual([]);
  });
});

describe("detectCycles", () => {
  test("acyclic workflow returns has_cycle: false", () => {
    const dag = buildStepDag(
      wf([
        { id: "a", kind: "transform", language: "javascript", expression: "return input.input;" },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    expect(detectCycles(dag).has_cycle).toBe(false);
  });

  test("two-step cycle is detected", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.b.data;",
        },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.has_cycle).toBe(true);
    expect([...(report.cycles[0]?.nodes ?? [])].sort()).toEqual(["a", "b"]);
  });

  test("three-step cycle is detected", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.b.data;",
        },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.c.data;",
        },
        {
          id: "c",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.has_cycle).toBe(true);
    expect([...(report.cycles[0]?.nodes ?? [])].sort()).toEqual(["a", "b", "c"]);
  });

  test("self-loop is detected as a 1-node cycle", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.has_cycle).toBe(true);
    expect(report.cycles[0]?.nodes).toEqual(["a"]);
  });

  test("cycle through a branch arm is detected", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "router",
          kind: "branch",
          when: "$scope.yes.data",
          then_steps: ["yes"],
        },
        { id: "yes", kind: "transform", language: "javascript", expression: "return 1;" },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.has_cycle).toBe(true);
    // Cycle: router → yes (data ref) → router (containment)
    const nodes = [...(report.cycles[0]?.nodes ?? [])].sort();
    expect(nodes).toEqual(["router", "yes"]);
  });

  test("renderCycleReport produces a readable one-line summary", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.b.data;",
        },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    const report = detectCycles(dag);
    const text = renderCycleReport(report);
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toMatch(/cycles:/);
  });
});

describe("topoSort", () => {
  test("linear workflow returns declaration order", () => {
    const dag = buildStepDag(
      wf([
        { id: "a", kind: "transform", language: "javascript", expression: "return input.input;" },
        { id: "b", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "c", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    expect(topoSort(dag)).toEqual(["a", "b", "c"]);
  });

  test("forward refs cause topo to swap so deps run first", () => {
    // s1 references s2 — declared in (s1, s2) order. topo must run
    // s2 first because s1 depends on it.
    const dag = buildStepDag(
      wf([
        {
          id: "s1",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.s2.data;",
        },
        { id: "s2", kind: "transform", language: "javascript", expression: "return 1;" },
      ]),
    );
    expect(topoSort(dag)).toEqual(["s2", "s1"]);
  });

  test("cyclic graph throws", () => {
    const dag = buildStepDag(
      wf([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.b.data;",
        },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    expect(() => topoSort(dag)).toThrow(/cycle/i);
  });

  test("deterministic tiebreaker between independent siblings", () => {
    const dag = buildStepDag(
      wf([
        { id: "alpha", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "beta", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    // Both have zero in-degree; declaration order wins.
    expect(topoSort(dag)).toEqual(["alpha", "beta"]);
  });
});
