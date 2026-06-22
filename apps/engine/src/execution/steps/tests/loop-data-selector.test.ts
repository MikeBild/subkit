// Loop steps may declare `data_selector` (a JS expression body) as the
// source-array selector. Failures throw real exceptions
// (`Data selector failed: <real msg>`) instead of the opaque
// `loop_over_unresolved` warning that path-style `over` produces. The
// schema requires exactly one of `over` or `data_selector` to be set.

import { describe, expect, test } from "bun:test";
import { LoopStepSchema } from "../../../workflows/types.ts";
import { runLoopStep } from "../loop.ts";

function ctx() {
  // Per-step run context — a stub abort signal that never fires, plus the
  // execution fields the data_selector path threads into the sandbox clock
  // (`started_at` / `execution_id`); the production ctx always carries them.
  return {
    signal: new AbortController().signal,
    started_at: new Date(1_700_000_000_000),
    execution_id: "00000000-0000-0000-0000-000000000099",
  } as unknown as Parameters<typeof runLoopStep>[0]["ctx"];
}

describe("loop step · data_selector (JS expression form)", () => {
  test("evaluates a JS arrow function against scope and returns the array", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "for_each_project",
      data_selector: "(sourceData) => sourceData.fetch_projects.data.projects",
      body: ["fetch_resources"],
      item_var: "project",
    });
    const scope = {
      fetch_projects: { data: { projects: [{ id: "p1" }, { id: "p2" }] } },
    };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([{ id: "p1" }, { id: "p2" }]);
  });

  test("a failing data_selector returns Data selector failed: <real exception>", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "broken",
      // Throws — cannot read `.projects` of undefined.
      data_selector: "(sourceData) => sourceData.does_not_exist.projects",
      body: ["body"],
      item_var: "project",
    });
    const result = await runLoopStep({ ctx: ctx(), step, scope: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("data_selector_error");
    expect(result.error?.message).toMatch(/^Data selector failed: /);
    // The actual JS exception leaks through (TypeError: Cannot read
    // properties of undefined …) — that's the whole point: actionable
    // signal instead of opaque "resolved to undefined".
    expect(result.error?.message).toMatch(/undefined|read prop/i);
  });

  test("data_selector returning a non-array surfaces loop_over_unresolved warning", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "wrong_shape",
      data_selector: "(sourceData) => sourceData.fetch_projects.data",
      body: ["body"],
      item_var: "project",
    });
    const scope = { fetch_projects: { data: { projects: [{ id: "p1" }] } } };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.[0]?.code).toBe("loop_over_unresolved");
    // Details carry the data_selector (not the over field) so the
    // model can see which form failed.
    expect((result.warnings?.[0]?.details as Record<string, unknown>)?.data_selector).toBeDefined();
    expect((result.warnings?.[0]?.details as Record<string, unknown>)?.over).toBeUndefined();
  });

  test("schema rejects a step that sets BOTH over and data_selector", () => {
    const parse = () =>
      LoopStepSchema.parse({
        kind: "loop",
        id: "ambiguous",
        over: "$scope.x.data",
        data_selector: "(s) => s.x.data",
        body: ["a"],
        item_var: "item",
      });
    expect(parse).toThrow(/exactly one/i);
  });

  test("schema rejects a step that sets NEITHER over nor data_selector", () => {
    const parse = () =>
      LoopStepSchema.parse({
        kind: "loop",
        id: "missing",
        body: ["a"],
        item_var: "item",
      });
    expect(parse).toThrow(/exactly one/i);
  });

  test("path-style `over` continues to work (backwards compatibility)", async () => {
    // The runtime calls jsonata(over).evaluate(scope), which treats
    // top-level keys as roots. Bare-path form is what jsonata resolves
    // directly against scope[key]; the documented `$scope.<key>` form
    // requires the workflow's top-level placeholder pipeline to
    // pre-resolve, which is out of scope for this unit test.
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "legacy",
      over: "fetch_projects.data.projects",
      body: ["body"],
      item_var: "project",
    });
    const scope = {
      fetch_projects: { data: { projects: [{ id: "p1" }, { id: "p2" }] } },
    };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([{ id: "p1" }, { id: "p2" }]);
  });
});
