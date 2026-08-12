// Binding contract for loop iterations (item_var retirement).
//
//   - `$item` + `$loop_index` are ALWAYS bound.
//   - The bare `item_var` name is bound ONLY when the stored definition
//     declares it (legacy versions executed via version_id) — new and
//     migrated definitions omit the field.
//   - Regression: a definition WITHOUT item_var that references a bare
//     iteration name gets a runtime `unresolved_identifier` warning,
//     not a silent empty result.

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

describe("buildLoopChildScope — conditional bare binding", () => {
  it("legacy definition declaring item_var binds the bare name AND the canonical bindings", () => {
    const scope = buildLoopChildScope({ item_var: "num" }, { upstream: { data: [1] } }, 42, 3);
    expect(scope.num).toBe(42);
    expect(scope.$item).toBe(42);
    expect(scope.$loop_index).toBe(3);
    expect(scope.upstream).toEqual({ data: [1] });
  });

  it("definition without item_var binds $item + $loop_index ONLY", () => {
    const scope = buildLoopChildScope({}, { upstream: { data: [1] } }, 42, 0);
    expect(scope.$item).toBe(42);
    expect(scope.$loop_index).toBe(0);
    expect(Object.keys(scope).sort()).toEqual(["$item", "$loop_index", "upstream"]);
  });

  it("empty-string item_var is treated as undeclared", () => {
    const scope = buildLoopChildScope({ item_var: "" }, {}, "x", 1);
    expect(Object.keys(scope).sort()).toEqual(["$item", "$loop_index"]);
  });
});

describe("runtime — loop-item bindings reach the transform body", () => {
  it("$item + $loop_index resolve for a definition without item_var", async () => {
    const childScope = buildLoopChildScope({}, {}, { name: "Ada" }, 0);
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

  it("legacy definition WITH item_var still binds the bare name into scope (stored-data contract)", async () => {
    const childScope = buildLoopChildScope({ item_var: "num" }, {}, 21, 0);
    const result = await runTransformStep({
      ctx: mkCtx(),
      step: {
        kind: "transform",
        id: "body",
        language: "javascript",
        expression: "return input.scope.num * 2;",
      },
      scope: childScope,
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe(42);
  });
});
