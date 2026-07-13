// Unit tests for detectTransformWarnings — the silent-data-loss emit that was
// specified in execution/types.ts + consumed by the dry-run repair loop but
// never wired. Covers the two production failure shapes that motivated the
// codes: a renderer that returns empty for every input (Notion blocks), and a
// projection that drops a field while mapping (the dropped-`resources` shape).

import { describe, expect, test } from "bun:test";
import { detectTransformWarnings } from "../transform-warnings.ts";

// Scope envelope mirrors the engine: scope[stepId] = { data: <output> }.
const env = (data: unknown) => ({ data });

describe("transform_empty_extraction", () => {
  test("empty string output + non-empty upstream → fires (Notion-renders-nothing shape)", () => {
    const w = detectTransformWarnings({
      step_id: "to_markdown",
      output: "",
      scope: { fetch_blocks: env([{ type: "toggle", has_children: true }]) },
    });
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe("transform_empty_extraction");
  });

  test("[] output + non-empty upstream → fires", () => {
    const w = detectTransformWarnings({
      step_id: "project",
      output: [],
      scope: { list: env([{ id: 1 }, { id: 2 }]) },
    });
    expect(w[0]?.code).toBe("transform_empty_extraction");
  });

  test("{} output + non-empty upstream → fires", () => {
    const w = detectTransformWarnings({
      step_id: "shape",
      output: {},
      scope: { fetch: env({ a: 1 }) },
    });
    expect(w[0]?.code).toBe("transform_empty_extraction");
  });

  test("empty output but ALSO empty upstream → does NOT fire (nothing to lose)", () => {
    const w = detectTransformWarnings({
      step_id: "project",
      output: [],
      scope: { list: env([]) },
    });
    expect(w).toHaveLength(0);
  });

  test("non-empty output → does NOT fire", () => {
    const w = detectTransformWarnings({
      step_id: "project",
      output: [{ id: 1 }],
      scope: { list: env([{ id: 1, name: "a" }]) },
    });
    expect(w.some((x) => x.code === "transform_empty_extraction")).toBe(false);
  });

  test("$-prefixed bindings are not counted as upstream data", () => {
    const w = detectTransformWarnings({
      step_id: "project",
      output: null,
      scope: { $input: { foo: "bar" }, $steps: { x: 1 } },
    });
    expect(w).toHaveLength(0);
  });
});

describe("transform_dropped_fields (informational)", () => {
  test("mapped array narrows a same-length source's keys → fires, names dropped field", () => {
    const w = detectTransformWarnings({
      step_id: "format_output",
      output: [
        { project_id: 1, project_name: "a" },
        { project_id: 2, project_name: "b" },
      ],
      scope: {
        loop: env([
          { project_id: 1, project_name: "a", resources: [1, 2] },
          { project_id: 2, project_name: "b", resources: [3] },
        ]),
      },
    });
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe("transform_dropped_fields");
    expect((w[0]!.details as { dropped_fields: string[] }).dropped_fields).toEqual(["resources"]);
  });

  test("output keys are NOT a subset (renamed/added) → does NOT fire", () => {
    const w = detectTransformWarnings({
      step_id: "reshape",
      output: [{ slug: "a" }],
      scope: { src: env([{ id: 1, name: "a" }]) },
    });
    expect(w.some((x) => x.code === "transform_dropped_fields")).toBe(false);
  });

  test("two same-length candidate arrays → ambiguous, does NOT fire", () => {
    const w = detectTransformWarnings({
      step_id: "reshape",
      output: [{ a: 1 }],
      scope: { x: env([{ a: 1, b: 2 }]), y: env([{ a: 9, c: 3 }]) },
    });
    expect(w.some((x) => x.code === "transform_dropped_fields")).toBe(false);
  });

  test("source array of different length → does NOT fire", () => {
    const w = detectTransformWarnings({
      step_id: "reshape",
      output: [{ a: 1 }],
      scope: {
        src: env([
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ]),
      },
    });
    expect(w.some((x) => x.code === "transform_dropped_fields")).toBe(false);
  });

  test("identical keys (nothing dropped) → does NOT fire", () => {
    const w = detectTransformWarnings({
      step_id: "passthrough",
      output: [{ a: 1, b: 2 }],
      scope: { src: env([{ a: 1, b: 2 }]) },
    });
    expect(w.some((x) => x.code === "transform_dropped_fields")).toBe(false);
  });
});
