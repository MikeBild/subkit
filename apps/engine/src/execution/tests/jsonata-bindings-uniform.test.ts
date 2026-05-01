// `$scope` / `$input` / `$steps` / `$<key>` bindings must work
// uniformly across every author-written JSONata site:
//
//   transform.expression  (already worked pre-fix)
//   loop.over             (was broken; session ebd66982: 105 307
//                          turn-tokens spent guessing $scope.X.data
//                          → undefined → step budget exhausted)
//   branch.when           (was broken for the same reason; less
//                          visible because branches usually use the
//                          bare path form)
//
// The data-handling skill promises uniform `$scope.<id>.data`
// access. These tests pin the contract so the regression can't
// reappear.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("jsonata-bindings-uniform");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("loop.over · honors $scope / $input bindings", () => {
  test("$scope.<id>.data resolves the same way it does inside transform.expression", async () => {
    // Repro of session ebd66982: a transform produces an array,
    // the loop's `over` is `$scope.<id>.data`. Pre-fix the loop
    // saw `undefined` because `$scope` was unbound; the LLM
    // spiraled trying alternative paths. Post-fix the loop walks
    // the array and the body runs once per element.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-scope-binding",
      steps: [
        {
          id: "extract_projects",
          kind: "transform",
          language: "jsonata",
          expression: "['alpha', 'beta', 'gamma']",
        },
        {
          id: "iter",
          kind: "loop",
          over: "$scope.extract_projects.data",
          item_var: "project",
          body: ["body"],
        },
        {
          id: "body",
          kind: "transform",
          language: "jsonata",
          expression: "$project",
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
    // No `loop_over_unresolved` warning — the loop walked the array.
    const loopWarning = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(loopWarning).toBeUndefined();
  });

  test("$input.<key> resolves inside loop.over", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-input-binding",
      input_schema: {
        type: "object",
        properties: { items: { type: "array" } },
      },
      steps: [
        {
          id: "iter",
          kind: "loop",
          over: "$input.items",
          item_var: "x",
          body: ["body"],
        },
        {
          id: "body",
          kind: "transform",
          language: "jsonata",
          expression: "$x * 2",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { items: [1, 2, 3] },
    });
    expect(result.status).toBe("succeeded");
    const loopWarning = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(loopWarning).toBeUndefined();
  });

  test("bare-path form `extract_projects.data` still works (back-compat)", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-bare-path",
      steps: [
        {
          id: "extract_projects",
          kind: "transform",
          language: "jsonata",
          expression: "['a', 'b']",
        },
        {
          id: "iter",
          kind: "loop",
          over: "extract_projects.data",
          item_var: "x",
          body: ["body"],
        },
        {
          id: "body",
          kind: "transform",
          language: "jsonata",
          expression: "$x",
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
    const loopWarning = (result.warnings ?? []).find((w) => w.code === "loop_over_unresolved");
    expect(loopWarning).toBeUndefined();
  });
});

describe("branch.when · honors $scope / $input bindings", () => {
  test("$scope.<id>.data inside branch.when resolves correctly", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "branch-scope-binding",
      steps: [
        {
          id: "fetch",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'tier': 'enterprise' }",
        },
        {
          id: "router",
          kind: "branch",
          when: "$scope.fetch.data.tier = 'enterprise'",
          then_steps: ["enterprise_path"],
          else_steps: ["self_serve_path"],
        },
        {
          id: "enterprise_path",
          kind: "transform",
          language: "jsonata",
          expression: "'ENTERPRISE'",
        },
        {
          id: "self_serve_path",
          kind: "transform",
          language: "jsonata",
          expression: "'SELF_SERVE'",
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
    // The enterprise arm took precedence — output is the enterprise
    // transform's value.
    expect(result.output).toBe("ENTERPRISE");
  });

  test("$input.<key> resolves inside branch.when", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "branch-input-binding",
      input_schema: {
        type: "object",
        properties: { tier: { type: "string" } },
      },
      steps: [
        {
          id: "router",
          kind: "branch",
          when: "$input.tier = 'enterprise'",
          then_steps: ["yes"],
          else_steps: ["no"],
        },
        {
          id: "yes",
          kind: "transform",
          language: "jsonata",
          expression: "'YES'",
        },
        {
          id: "no",
          kind: "transform",
          language: "jsonata",
          expression: "'NO'",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { tier: "enterprise" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("YES");
  });
});
