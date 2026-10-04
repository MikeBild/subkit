import { describe, expect, test } from "bun:test";
import { LoopStepSchema } from "../../../workflows/types.ts";
import { runLoopStep } from "../loop.ts";

function ctx() {
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
      data_selector: "(sourceData) => sourceData.does_not_exist.projects",
      body: ["body"],
    });
    const result = await runLoopStep({ ctx: ctx(), step, scope: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("data_selector_error");
    expect(result.error?.message).toMatch(/^Data selector failed: /);
    expect(result.error?.message).toMatch(/undefined|read prop/i);
  });

  test("data_selector returning a non-array surfaces loop_over_unresolved warning", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "wrong_shape",
      data_selector: "(sourceData) => sourceData.fetch_projects.data",
      body: ["body"],
    });
    const scope = { fetch_projects: { data: { projects: [{ id: "p1" }] } } };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.[0]?.code).toBe("loop_over_unresolved");
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
      });
    expect(parse).toThrow(/exactly one/i);
  });

  test("schema rejects a step that sets NEITHER over nor data_selector", () => {
    const parse = () =>
      LoopStepSchema.parse({
        kind: "loop",
        id: "missing",
        body: ["a"],
      });
    expect(parse).toThrow(/exactly one/i);
  });

  test("path-style `over` resolves against scope", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "path_over",
      over: "fetch_projects.data.projects",
      body: ["body"],
    });
    const scope = {
      fetch_projects: { data: { projects: [{ id: "p1" }, { id: "p2" }] } },
    };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([{ id: "p1" }, { id: "p2" }]);
  });
});
