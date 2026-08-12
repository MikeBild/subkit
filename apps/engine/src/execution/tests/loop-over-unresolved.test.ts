// Bug F regression: when a loop's `over` expression resolves to a
// non-array (undefined / null / scalar / plain object), the loop
// silently produced [] with no signal. Session 86de186b: the LLM
// authored `over: "$scope.fetch_projects.data.projects"` 9 times
// against an output where `data` was the projects array directly,
// so the path resolved to undefined and the loop ran zero
// iterations. Post-fix the driver emits `loop_over_unresolved`
// with the resolved type + scope keys so the LLM can fix the path.

import { describe, expect, test } from "bun:test";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { runLoopStep } from "../steps/loop.ts";
import type { StepRunContext } from "../types.ts";

const TEST_NOW_MS = getTestNow();

function ctx(scope: Record<string, unknown>): StepRunContext {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    db: {} as any,
    tenant_id: "t-loop",
    execution_id: "00000000-0000-0000-0000-000000000099",
    workflow_id: "00000000-0000-0000-0000-0000000000aa",
    workflow_version_id: "00000000-0000-0000-0000-0000000000ab",
    request_source: "chat",
    parent_execution_id: null,
    depth: 0,
    scope,
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "test-wf",
    trace_id: null,
    execution_mode: "dev",
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    step: {} as any,
    step_index: 0,
    step_row_id: "00000000-0000-0000-0000-000000000aaa",
    signal: new AbortController().signal,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
}

describe("runLoopStep · loop_over_unresolved warning", () => {
  test("emits warning when `over` resolves to undefined", async () => {
    const result = await runLoopStep({
      ctx: ctx({ fetch_projects: { data: { projects: [{ id: "p1" }] } } }),
      step: {
        id: "project_loop",
        kind: "loop",
        over: "$scope.fetch_projects.data.something_wrong",
        body: ["fetch_resources"],
        item_var: "project",
      },
      scope: { fetch_projects: { data: { projects: [{ id: "p1" }] } } },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([]);
    const warning = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("project_loop");
    expect(warning?.message).toContain("undefined/null");
    const details = warning?.details as { available_scope_keys?: string[] } | undefined;
    expect(details?.available_scope_keys).toContain("fetch_projects");
  });

  test("emits warning when `over` resolves to a non-array object", async () => {
    const result = await runLoopStep({
      ctx: ctx({ src: { count: 5 } }),
      step: {
        id: "project_loop",
        kind: "loop",
        over: "src",
        body: ["b"],
        item_var: "x",
      },
      scope: { src: { count: 5 } },
    });
    expect(result.status).toBe("succeeded");
    const warning = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("object (not array)");
  });

  test("does NOT emit warning when `over` resolves to a real array", async () => {
    const result = await runLoopStep({
      ctx: ctx({ src: [{ id: 1 }, { id: 2 }] }),
      step: {
        id: "project_loop",
        kind: "loop",
        over: "src",
        body: ["b"],
        item_var: "x",
      },
      scope: { src: [{ id: 1 }, { id: 2 }] },
    });
    expect(result.status).toBe("succeeded");
    expect(Array.isArray(result.output)).toBe(true);
    expect((result.output as unknown[]).length).toBe(2);
    const warning = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(warning).toBeUndefined();
  });

  test("empty array source resolves cleanly without the warning", async () => {
    // Empty array is a legitimate "no data to iterate" shape, not a
    // path mismatch — the warning would over-flag legitimate flows.
    const result = await runLoopStep({
      ctx: ctx({ src: [] }),
      step: {
        id: "project_loop",
        kind: "loop",
        over: "src",
        body: ["b"],
        item_var: "x",
      },
      scope: { src: [] },
    });
    const warning = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(warning).toBeUndefined();
  });
});
