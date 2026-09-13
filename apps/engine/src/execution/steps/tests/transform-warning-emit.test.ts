// Integration-ish guard: the transform STEP (not just the pure detector)
// attaches transform_empty_extraction / transform_dropped_fields to its
// StepResult.warnings after running the real QuickJS body. This is the layer
// the unit detector test (transform-warnings.test.ts) does not cover — it
// proves the wiring from a live transform execution to the warning that the
// dry-run repair gate consumes.

import { describe, expect, test } from "bun:test";

import { RunLlmBudget } from "../../../llm/accounting/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import type { StepRunContext } from "../../types.ts";
import { runTransformStep } from "../transform.ts";

const TEST_NOW_MS = getTestNow();

function ctx(scope: Record<string, unknown>): StepRunContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub; no DB needed for a non-offloaded scope
    db: {} as any,
    tenant_id: "t-transform",
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
    step: {} as any,
    step_index: 0,
    step_row_id: "00000000-0000-0000-0000-000000000aaa",
    signal: new AbortController().signal,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
}

describe("runTransformStep · silent-data-loss warnings", () => {
  test("emits transform_empty_extraction when the body returns [] over non-empty upstream", async () => {
    const scope = { fetch_blocks: { data: [{ type: "toggle" }, { type: "callout" }] } };
    const result = await runTransformStep({
      ctx: ctx(scope),
      step: {
        id: "to_markdown",
        kind: "transform",
        language: "javascript",
        // Mimics a renderer that matches nothing and returns empty.
        expression: "return [];",
      },
      scope,
      input: {},
    });
    expect(result.status).toBe("succeeded");
    const w = (result.warnings ?? []).find((x) => x.code === "transform_empty_extraction");
    expect(w).toBeDefined();
    expect(w?.message).toContain("to_markdown");
  });

  test("emits transform_dropped_fields when a mapped array narrows the source keys", async () => {
    const scope = {
      loop: {
        data: [
          { id: 1, name: "a", resources: [1] },
          { id: 2, name: "b", resources: [2] },
        ],
      },
    };
    const result = await runTransformStep({
      ctx: ctx(scope),
      step: {
        id: "format_output",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.loop.data.map(r => ({ id: r.id, name: r.name }));",
      },
      scope,
      input: {},
    });
    expect(result.status).toBe("succeeded");
    const w = (result.warnings ?? []).find((x) => x.code === "transform_dropped_fields");
    expect(w).toBeDefined();
    expect((w!.details as { dropped_fields: string[] }).dropped_fields).toContain("resources");
  });

  test("no warning when the transform returns a full reshape", async () => {
    const scope = { src: { data: [{ id: 1, name: "a" }] } };
    const result = await runTransformStep({
      ctx: ctx(scope),
      step: {
        id: "reshape",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.src.data.map(r => ({ id: r.id, name: r.name }));",
      },
      scope,
      input: {},
    });
    expect(result.status).toBe("succeeded");
    expect(result.warnings ?? []).toHaveLength(0);
  });
});
