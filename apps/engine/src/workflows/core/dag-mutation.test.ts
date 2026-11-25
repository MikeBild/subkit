import { describe, expect, test } from "bun:test";
import type { WorkflowDef } from "../types.ts";
import { buildStepDag, detectCycles, renderCycleReport, topoSort } from "./dag.ts";

function workflow(steps: WorkflowDef["steps"]): WorkflowDef {
  return { name: "dag-mutation", steps };
}

describe("DAG reference grammars", () => {
  test("retains each supported reference grammar through nested request data", () => {
    const dag = buildStepDag(
      workflow([
        { id: "scope_id", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "jsonata_id", kind: "transform", language: "javascript", expression: "return 2;" },
        { id: "bare_id", kind: "transform", language: "javascript", expression: "return 3;" },
        { id: "js_id", kind: "transform", language: "javascript", expression: "return 4;" },
        {
          id: "consumer",
          kind: "request",
          method: "POST",
          body: {
            placeholder: "${ scope.scope_id.data.value }",
            nested: ["$scope.jsonata_id.data", "bare_id.value", "input.sourceData.js_id.data"],
          },
        },
      ]),
    );
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        { from: "consumer", to: "scope_id", reason: "scope_placeholder" },
        { from: "consumer", to: "jsonata_id", reason: "jsonata_scope" },
        { from: "consumer", to: "bare_id", reason: "jsonata_bare" },
        { from: "consumer", to: "js_id", reason: "js_scope" },
      ]),
    );
  });

  test("does not infer bare references inside an existing scope path", () => {
    const dag = buildStepDag(
      workflow([
        { id: "scope", kind: "transform", language: "javascript", expression: "return 1;" },
        {
          id: "consumer",
          kind: "transform",
          language: "javascript",
          expression: "return $scope.scope.data + sourceData.value;",
        },
      ]),
    );
    expect(dag.edges).toEqual([{ from: "consumer", to: "scope", reason: "jsonata_scope" }]);
  });

  test("recognizes data selectors at identifier boundaries while preserving explicit self references", () => {
    const dag = buildStepDag(
      workflow([
        { id: "read", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "reader", kind: "transform", language: "javascript", expression: "return 2;" },
        {
          id: "select",
          kind: "transform",
          language: "javascript",
          expression: "return 3;",
          data_selector: "read.value + thread.reader + select.value",
        },
      ]),
    );
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        { from: "select", to: "read", reason: "data_selector" },
        { from: "select", to: "reader", reason: "data_selector" },
      ]),
    );
    expect(dag.edges).toContainEqual({ from: "select", to: "select", reason: "jsonata_bare" });
  });

  test("orders a transform after the step its input_from names, even without a dot path", () => {
    const dag = buildStepDag(
      workflow([
        { id: "convert", kind: "transform", language: "html-to-markdown", input_from: "fetch" },
        { id: "fetch", kind: "request", method: "GET", url: "https://example.test" },
      ]),
    );
    expect(dag.edges).toEqual([{ from: "convert", to: "fetch", reason: "transform_input" }]);
    expect(topoSort(dag)).toEqual(["fetch", "convert"]);
  });

  test("deduplicates adjacency pairs while retaining reference reasons for diagnostics", () => {
    const dag = buildStepDag(
      workflow([
        { id: "source", kind: "transform", language: "javascript", expression: "return 1;" },
        {
          id: "consumer",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.source.data + $scope.source.data;",
        },
      ]),
    );
    expect(
      dag.edges
        .filter((edge) => edge.from === "consumer" && edge.to === "source")
        .map((edge) => edge.reason)
        .sort(),
    ).toEqual(["js_scope", "jsonata_scope"]);
    expect(dag.adjacency.get("consumer")).toEqual(["source"]);
  });
});

describe("DAG containment and order", () => {
  test("distinguishes plain JavaScript scope paths from JSONata paths", () => {
    const dag = buildStepDag(
      workflow([
        { id: "source", kind: "transform", language: "javascript", expression: "return 1;" },
        {
          id: "consumer",
          kind: "transform",
          language: "javascript",
          expression: "return scope.source.data;",
        },
      ]),
    );
    expect(dag.edges).toEqual([{ from: "consumer", to: "source", reason: "js_scope" }]);
  });

  test("drops unknown references and deduplicates repeated references of the same grammar", () => {
    const dag = buildStepDag(
      workflow([
        { id: "known", kind: "transform", language: "javascript", expression: "return 1;" },
        {
          id: "consumer",
          kind: "transform",
          language: "javascript",
          expression:
            "return input.scope.unknown.data + input.scope.known.data + input.scope.known.data;",
        },
      ]),
    );
    expect(dag.edges).toEqual([{ from: "consumer", to: "known", reason: "js_scope" }]);
  });

  test("walks arrays and nested objects but ignores non-string scalar fields", () => {
    const dag = buildStepDag(
      workflow([
        { id: "one", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "two", kind: "transform", language: "javascript", expression: "return 2;" },
        {
          id: "consumer",
          kind: "request",
          method: "POST",
          body: {
            entries: [null, false, 0, { reference: "${scope.one.data}" }, "$scope.two.data"],
          },
        },
      ]),
    );
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        { from: "consumer", to: "one", reason: "scope_placeholder" },
        { from: "consumer", to: "two", reason: "jsonata_scope" },
      ]),
    );
  });

  test("ignores annotations attached to arrays", () => {
    const annotatedArray = Object.assign(["literal"], {
      annotation: "input.scope.array_source.data",
    });
    const dag = buildStepDag(
      workflow([
        { id: "array_source", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "consumer", kind: "request", method: "POST", body: { entries: annotatedArray } },
      ]),
    );
    expect(dag.edges).toEqual([]);
  });

  test("does not synthesize selector dependencies when the selector is absent", () => {
    const dag = buildStepDag(
      workflow([
        { id: "undefined", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "reader", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    expect(dag.edges).toEqual([]);
  });

  test("selector matching is bounded and never treats a prefix as a step identifier", () => {
    const dag = buildStepDag(
      workflow([
        { id: "read", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "reader", kind: "transform", language: "javascript", expression: "return 2;" },
        {
          id: "consumer",
          kind: "transform",
          language: "javascript",
          expression: "return 3;",
          data_selector: "reader.value + unread.value",
        },
      ]),
    );
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        { from: "consumer", to: "reader", reason: "jsonata_bare" },
        { from: "consumer", to: "reader", reason: "data_selector" },
      ]),
    );
    expect(dag.edges).not.toContainEqual({ from: "consumer", to: "read", reason: "data_selector" });
  });

  test("does not manufacture a containment self-loop or unknown containment child", () => {
    const dag = buildStepDag(
      workflow([{ id: "branch", kind: "branch", when: "true", then_steps: ["branch", "missing"] }]),
    );
    expect(dag.edges).toEqual([]);
  });

  test("does not invent an omitted else arm, even when that id is otherwise known", () => {
    const dag = buildStepDag(
      workflow([
        { id: "branch", kind: "branch", when: "true", then_steps: [] },
        {
          id: "Stryker was here",
          kind: "transform",
          language: "javascript",
          expression: "return 1;",
        },
      ]),
    );
    expect(dag.edges).toEqual([]);
  });

  test("keeps containment adjacency even when it shares a reference pair", () => {
    const dag = buildStepDag(
      workflow([
        { id: "branch", kind: "branch", when: "$scope.child.data", then_steps: ["child"] },
        { id: "child", kind: "transform", language: "javascript", expression: "return 1;" },
      ]),
    );
    expect(dag.adjacency.get("branch")).toEqual(["child"]);
    expect(dag.adjacency.get("child")).toEqual(["branch"]);
  });

  test("reports every self-reference reason and preserves its renderer output", () => {
    const dag = buildStepDag(
      workflow([
        {
          id: "self",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.self.data + $scope.self.data;",
          data_selector: "self.value",
        },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.cycles).toEqual(
      expect.arrayContaining([
        { nodes: ["self"], reasons: ["jsonata_scope"] },
        { nodes: ["self"], reasons: ["js_scope"] },
        { nodes: ["self"], reasons: ["jsonata_bare"] },
      ]),
    );
    expect(renderCycleReport(report)).toContain("self → self");
  });

  test("topological ordering keeps declaration order only among simultaneously ready steps", () => {
    const dag = buildStepDag(
      workflow([
        {
          id: "late",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.dep.data;",
        },
        { id: "independent", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "dep", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    expect(topoSort(dag)).toEqual(["independent", "dep", "late"]);
  });

  test("keeps all valid branch and parallel containment dependencies", () => {
    const dag = buildStepDag(
      workflow([
        { id: "branch", kind: "branch", when: "true", then_steps: ["yes"], else_steps: ["no"] },
        { id: "parallel", kind: "parallel", branches: [["left"], ["right"]] },
        { id: "yes", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "no", kind: "transform", language: "javascript", expression: "return 2;" },
        { id: "left", kind: "transform", language: "javascript", expression: "return 3;" },
        { id: "right", kind: "transform", language: "javascript", expression: "return 4;" },
      ]),
    );
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        { from: "yes", to: "branch", reason: "branch_arm" },
        { from: "no", to: "branch", reason: "branch_arm" },
        { from: "left", to: "parallel", reason: "parallel_branch" },
        { from: "right", to: "parallel", reason: "parallel_branch" },
      ]),
    );
    const sorted = topoSort(dag);
    for (const edge of dag.edges)
      expect(sorted.indexOf(edge.to)).toBeLessThan(sorted.indexOf(edge.from));
  });

  test("cycle reports retain the actual edge reasons and renderer omits no-cycle text", () => {
    const dag = buildStepDag(
      workflow([
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
    expect(report.cycles).toEqual([{ nodes: ["a", "b"], reasons: ["js_scope", "js_scope"] }]);
    expect(renderCycleReport(report)).toBe("cycles: a → b → a (via js_scope / js_scope)");
    expect(renderCycleReport({ has_cycle: false, cycles: [] })).toBe("");
  });

  test("reports a cycle's reasons only from its directed perimeter, not unrelated SCC edges", () => {
    const dag = buildStepDag(
      workflow([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.b.data + input.scope.c.data;",
        },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.c.data;",
        },
        { id: "c", kind: "transform", language: "javascript", expression: "return $scope.a.data;" },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.cycles).toEqual([
      { nodes: ["a", "b", "c"], reasons: ["js_scope", "js_scope", "jsonata_scope"] },
    ]);
  });

  test("reports a branched SCC even when Tarjan member order is not an edge-by-edge cycle", () => {
    const dag = buildStepDag(
      workflow([
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.b.data + input.scope.c.data;",
        },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
        {
          id: "c",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data;",
        },
      ]),
    );
    expect(detectCycles(dag)).toEqual({
      has_cycle: true,
      cycles: [{ nodes: ["a", "b", "c"], reasons: ["js_scope", "scope_placeholder", "js_scope"] }],
    });
  });

  test("accepts a structurally sparse public DAG without traversing invented neighbours", () => {
    expect(detectCycles({ step_ids: ["isolated"], edges: [], adjacency: new Map() })).toEqual({
      has_cycle: false,
      cycles: [],
    });
  });

  test("does not expose an implementation sentinel even when its text is a public node id", () => {
    const sentinel = "Stryker was here";
    const dag = {
      step_ids: [sentinel, "peer"],
      edges: [
        { from: sentinel, to: "peer", reason: "js_scope" as const },
        { from: "peer", to: sentinel, reason: "branch_arm" as const },
      ],
      adjacency: new Map([
        [sentinel, ["peer"]],
        ["peer", [sentinel]],
      ]),
    };
    expect(detectCycles(dag)).toEqual({
      has_cycle: true,
      cycles: [{ nodes: [sentinel, "peer"], reasons: ["js_scope", "branch_arm"] }],
    });
  });

  test("visits duplicate public node ids only once before scanning shared adjacency", () => {
    const count = 20_000;
    const roots = Array.from({ length: count }, () => "root");
    const neighbours = Array.from({ length: count }, () => "leaf");
    const dag = {
      step_ids: [...roots, "leaf"],
      edges: [],
      adjacency: new Map<string, string[]>([
        ["root", neighbours],
        ["leaf", []],
      ]),
    };
    const started = performance.now();
    expect(detectCycles(dag)).toEqual({ has_cycle: false, cycles: [] });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("does not let a completed acyclic dependency hide a later SCC", () => {
    const dag = buildStepDag(
      workflow([
        { id: "a", kind: "transform", language: "javascript", expression: "return 1;" },
        {
          id: "b",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.a.data + input.scope.c.data;",
        },
        {
          id: "c",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.b.data;",
        },
      ]),
    );
    expect(detectCycles(dag)).toEqual({
      has_cycle: true,
      cycles: [{ nodes: ["b", "c"], reasons: ["js_scope", "js_scope"] }],
    });
  });

  test("sorts a zero-declaration-index ready step before later ready siblings", () => {
    const dag = buildStepDag(
      workflow([
        { id: "first", kind: "transform", language: "javascript", expression: "return 1;" },
        {
          id: "dependent",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.first.data;",
        },
        { id: "later", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    expect(topoSort(dag)).toEqual(["first", "dependent", "later"]);
  });

  test("promotes an earlier declared step when it becomes ready after a later sibling", () => {
    const dag = buildStepDag(
      workflow([
        {
          id: "early",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.trigger.data;",
        },
        { id: "trigger", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "late", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    expect(topoSort(dag)).toEqual(["trigger", "early", "late"]);
  });

  test("uses lexical fallback ordering for duplicate declarations and foreign edge origins", () => {
    const ordered = {
      step_ids: ["root", "root", "root"],
      edges: [
        { from: "a", to: "root", reason: "js_scope" as const },
        { from: "z", to: "root", reason: "js_scope" as const },
      ],
      adjacency: new Map([["root", []] as const]),
    };
    const reversed = { ...ordered, edges: [...ordered.edges].reverse() };
    const unicode = {
      ...ordered,
      edges: [
        { from: "ä", to: "root", reason: "js_scope" as const },
        { from: "z", to: "root", reason: "js_scope" as const },
      ],
    };
    expect(topoSort(ordered)).toEqual(["root", "a", "z"]);
    expect(topoSort(reversed)).toEqual(["root", "a", "z"]);
    expect(topoSort(unicode)).toEqual(["root", "z", "ä"]);
  });

  test("treats a self-reference as diagnostic-only for executable ordering", () => {
    const dag = buildStepDag(
      workflow([
        {
          id: "self",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.self.data;",
        },
      ]),
    );
    expect(topoSort(dag)).toEqual(["self"]);
  });

  test("unlocks a dependent only after every distinct prerequisite has completed", () => {
    const dag = buildStepDag(
      workflow([
        {
          id: "dependent",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.left.data + input.scope.right.data;",
        },
        { id: "left", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "right", kind: "transform", language: "javascript", expression: "return 2;" },
      ]),
    );
    expect(topoSort(dag)).toEqual(["left", "right", "dependent"]);
  });

  test("renders cycles with and without reasons and separates multiple reports", () => {
    expect(
      renderCycleReport({
        has_cycle: true,
        cycles: [
          { nodes: ["solo"], reasons: [] },
          { nodes: ["a", "b"], reasons: ["branch_arm", "js_scope"] },
        ],
      }),
    ).toBe("cycles: solo → solo; a → b → a (via branch_arm / js_scope)");
  });
});

test("a missing adjacency entry cannot invent an edge to another public map entry", () => {
  expect(
    detectCycles({
      step_ids: ["root"],
      edges: [],
      adjacency: new Map([["Stryker was here", ["root"]]]),
    }),
  ).toEqual({ has_cycle: false, cycles: [] });
});

test("ignores function-valued structural extensions on a workflow step", () => {
  const annotatedFunction = Object.assign(() => undefined, {
    annotation: "input.scope.source.data",
  });
  const definition = workflow([
    { id: "source", kind: "transform", language: "javascript", expression: "return 1;" },
    { id: "consumer", kind: "request", method: "POST" },
  ]);
  const extendedStep = Object.assign(definition.steps[1]!, { extension: annotatedFunction });
  expect(buildStepDag(workflow([definition.steps[0]!, extendedStep])).edges).toEqual([]);
});
