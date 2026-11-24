import { describe, expect, test } from "bun:test";
import { buildStepDag, detectCycles } from "../core/dag.ts";
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
          kind: "request",
          method: "POST",
          url: "https://x/z",
          body: "fetch.data.id",
        },
      ]),
    );
    const edge = dag.edges.find((e) => e.from === "shape" && e.to === "fetch");
    expect(edge?.reason).toBe("jsonata_bare");
  });

  test("cycle via bare-path forward refs is detected", () => {
    const dag = buildStepDag(
      wf([
        { id: "a", kind: "transform", expression: "1", data_selector: "b.data" },
        { id: "b", kind: "transform", expression: "$scope.a.data" },
      ]),
    );
    const report = detectCycles(dag);
    expect(report.has_cycle).toBe(true);
    expect(new Set(report.cycles[0]?.nodes ?? [])).toEqual(new Set(["a", "b"]));
  });

  test("bare identifiers in a JavaScript transform add no step edge (#520)", () => {
    const dag = buildStepDag(
      wf([
        { id: "scrape", kind: "request", method: "POST", url: "https://x/scrape" },
        {
          id: "normalise",
          kind: "transform",
          language: "javascript",
          expression:
            "const result = input.scope.scrape.data; if (result.error) return []; return result.selector;",
        },
        {
          id: "send_digest",
          kind: "request",
          method: "POST",
          url: "https://x/send",
          body: "${scope.normalise.data}",
        },
        { id: "result", kind: "transform", expression: "return input.scope.send_digest.status;" },
      ]),
    );
    expect(dag.edges.find((e) => e.from === "normalise" && e.to === "result")).toBeUndefined();
    expect(dag.edges).toContainEqual({ from: "normalise", to: "scrape", reason: "js_scope" });
    expect(detectCycles(dag).has_cycle).toBe(false);
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

test("data selectors add bounded step references without self or partial-name dependencies", () => {
  const dag = buildStepDag(
    wf([
      { id: "fetch-data", kind: "transform", expression: "1" },
      { id: "fetch", kind: "transform", expression: "2" },
      { id: "unused", kind: "transform", expression: "3" },
      {
        id: "shape",
        kind: "transform",
        expression: "4",
        data_selector: "fetch-data.items + shape",
      },
    ]),
  );
  expect(dag.edges.filter((edge) => edge.reason === "data_selector")).toEqual([
    { from: "shape", to: "fetch-data", reason: "data_selector" },
  ]);
  expect(dag.adjacency.get("shape")).toEqual(["fetch-data"]);
});

test("data selector references at either boundary remain dependencies", () => {
  for (const data_selector of ["fetch", "(fetch)", "fetch.items", "items[fetch]"]) {
    const dag = buildStepDag(
      wf([
        { id: "fetch", kind: "transform", expression: "1" },
        { id: "shape", kind: "transform", expression: "2", data_selector },
      ]),
    );
    expect(dag.edges).toContainEqual({ from: "shape", to: "fetch", reason: "data_selector" });
  }
  for (const data_selector of ["prefixfetch", "fetch_suffix", "fetch-extra", "not_fetch"]) {
    const dag = buildStepDag(
      wf([
        { id: "fetch", kind: "transform", expression: "1" },
        { id: "shape", kind: "transform", expression: "2", data_selector },
      ]),
    );
    expect(dag.edges.filter((edge) => edge.reason === "data_selector")).toEqual([]);
  }
});
