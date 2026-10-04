import { describe, expect, it } from "bun:test";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { buildLoopChildScope } from "../loop-scope.ts";
import { runTransformStep } from "../steps/transform.ts";
import type { StepRunContext } from "../types.ts";

const TEST_NOW_MS = getTestNow();

function mkCtx(): StepRunContext {
  return {
    db: undefined as unknown as StepRunContext["db"],
    tenant_id: "t",
    execution_id: "e",
    workflow_id: "w",
    workflow_version_id: "v",
    request_source: "mcp",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope: {},
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "s",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step: {
      kind: "transform",
      id: "body",
      language: "javascript",
      expression: "return null;",
    },
    step_index: 0,
    step_row_id: "r",
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
}

describe("buildLoopChildScope", () => {
  it("binds $item + $loop_index over the run scope", () => {
    const scope = buildLoopChildScope({ upstream: { data: [1] } }, 42, 0);
    expect(scope.$item).toBe(42);
    expect(scope.$loop_index).toBe(0);
    expect(Object.keys(scope).sort()).toEqual(["$item", "$loop_index", "upstream"]);
  });
});

describe("runtime — loop-item bindings reach the transform body", () => {
  it("$item + $loop_index resolve in the transform body", async () => {
    const childScope = buildLoopChildScope({}, { name: "Ada" }, 0);
    const result = await runTransformStep({
      ctx: mkCtx(),
      step: {
        kind: "transform",
        id: "body",
        language: "javascript",
        expression: "return { name: input.scope.$item.name, idx: input.scope.$loop_index };",
      },
      scope: childScope,
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ name: "Ada", idx: 0 });
    expect(result.warnings ?? []).toHaveLength(0);
  });
});
