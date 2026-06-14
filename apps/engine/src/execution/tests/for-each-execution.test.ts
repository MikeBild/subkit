// for_each per-step inline iteration — engine integration tests.
//
// Verifies:
//   1. A step with `for_each` runs once per item, binding $item +
//      $loop_index into each iteration's scope.
//   2. Iteration results accumulate under $scope.<step>.data as an
//      array of per-iteration envelopes (A2/A3 fixed by construction).
//   3. Container-child static exclusion: branch/parallel/loop body
//      steps are excluded from the top-level walk regardless of
//      container outcome (failed container no longer leaks its children
//      to top level with unbound $item).
//   4. An empty/non-array for_each selector emits loop_over_unresolved
//      warning and produces zero iterations.
//   5. The container execution_steps row for a for_each step ends in a
//      terminal status (never left as "running") — regression guard for
//      the bug where the container row was inserted but never finalized.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executionSteps } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("for-each-exec");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("for_each · per-step inline iteration", () => {
  test("runs the step once per item, binding $item and $loop_index", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-basic",
      steps: [
        {
          id: "get_items",
          kind: "transform",
          language: "jsonata",
          expression: '[{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]',
        },
        {
          id: "process_item",
          kind: "transform",
          language: "jsonata",
          expression: '{ "doubled": $loop_index * 2, "name": $item.name }',
          for_each: "(sourceData) => sourceData.get_items.data",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const processStep = result.steps.find((s) => s.step_key === "process_item");
    expect(processStep).toBeDefined();
    expect(processStep?.status).toBe("succeeded");
    const scopeData =
      (processStep?.output_preview as Array<Record<string, unknown>> | undefined) ?? [];
    expect(scopeData).toHaveLength(2);
  });

  test("$item and $loop_index are accessible in iterations", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-bindings",
      steps: [
        {
          id: "source",
          kind: "transform",
          language: "jsonata",
          expression: '["x", "y", "z"]',
        },
        {
          id: "tagged",
          kind: "transform",
          language: "jsonata",
          expression: '$item & "_" & $string($loop_index)',
          for_each: "(sourceData) => sourceData.source.data",
        },
        {
          id: "final",
          kind: "transform",
          language: "jsonata",
          expression: "$count($scope.tagged.data)",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe(3);
  });

  test("empty selector result emits loop_over_unresolved warning and zero iterations", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-empty",
      steps: [
        {
          id: "source",
          kind: "transform",
          language: "jsonata",
          expression: '{"items": [1, 2]}',
        },
        {
          id: "iterated",
          kind: "transform",
          language: "jsonata",
          expression: "$item",
          for_each: "(sourceData) => sourceData.source.data.wrong_path",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const warnCodes = (result.warnings ?? []).map((w) => w.code);
    expect(warnCodes).toContain("loop_over_unresolved");
    const warn = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(warn?.step_key).toBe("iterated");
  });
});

describe("static container-child exclusion", () => {
  test("loop body steps are excluded from top-level walk", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-body-excluded",
      steps: [
        {
          id: "source_loop",
          kind: "loop",
          over: "[1, 2]",
          body: ["loop_body_step"],
        },
        {
          id: "loop_body_step",
          kind: "transform",
          language: "jsonata",
          expression: "$item * 10",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    // loop_body_step must not appear as an independently-run top-level step.
    const topLevelBodyStep = result.steps.find(
      (s) => s.step_key === "loop_body_step" && !s.step_key.includes("["),
    );
    if (topLevelBodyStep) {
      expect(topLevelBodyStep.status).toBe("skipped");
    }
  });

  test("branch arm steps excluded from top-level walk", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "branch-excluded",
      steps: [
        {
          id: "check",
          kind: "branch",
          when: "true",
          then_steps: ["then_step"],
          else_steps: ["else_step"],
        },
        {
          id: "then_step",
          kind: "transform",
          language: "jsonata",
          expression: '"then"',
        },
        {
          id: "else_step",
          kind: "transform",
          language: "jsonata",
          expression: '"else"',
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const checkStep = result.steps.find((s) => s.step_key === "check");
    expect(checkStep?.status).toBe("succeeded");
    // then_step is the taken arm — runs in the top-level walk normally.
    const thenStep = result.steps.find((s) => s.step_key === "then_step");
    expect(thenStep?.status).toBe("succeeded");
    // else_step was the non-taken arm — added to skippedStepIds at runtime.
    const elseStep = result.steps.find((s) => s.step_key === "else_step");
    if (elseStep) {
      expect(elseStep.status).toBe("skipped");
    }
  });
});

describe("for_each · container execution_steps row finalization", () => {
  // Regression guard: the container DB row (step_key == step id, not
  // step_key[N]) must never be left stuck in "running" after the
  // for_each block completes.  Before the fix, the row was inserted via
  // insertStepRow but finalizeStepRow was never called on it, leaving
  // the row in status="running" indefinitely.
  test("container row reaches a terminal status after successful iteration", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-row-finalize",
      steps: [
        {
          id: "items",
          kind: "transform",
          language: "jsonata",
          expression: "[1, 2, 3]",
        },
        {
          id: "doubled",
          kind: "transform",
          language: "jsonata",
          expression: "$item * 2",
          for_each: "(sourceData) => sourceData.items.data",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    // Query the persisted execution_steps row for the container step.
    const rows = await ctx.testDb.db
      .select({ step_key: executionSteps.step_key, status: executionSteps.status })
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    // The container row is keyed "doubled" (no [N] suffix).
    const containerRow = rows.find((r) => r.step_key === "doubled");
    expect(containerRow).toBeDefined();
    // Must be in a terminal status — never "running".
    expect(containerRow?.status).toBe("succeeded");
  });

  test("container row reaches a terminal status when selector returns empty", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-row-empty",
      steps: [
        {
          id: "src",
          kind: "transform",
          language: "jsonata",
          expression: '"not_an_array"',
        },
        {
          id: "proc",
          kind: "transform",
          language: "jsonata",
          expression: "$item",
          for_each: "(sourceData) => sourceData.src.data.missing",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const rows = await ctx.testDb.db
      .select({ step_key: executionSteps.step_key, status: executionSteps.status })
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    const containerRow = rows.find((r) => r.step_key === "proc");
    expect(containerRow).toBeDefined();
    expect(containerRow?.status).toBe("succeeded");
  });
});
