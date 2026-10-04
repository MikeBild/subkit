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
  test("$scope.<id>.data resolves the same way it does inside a JS transform body", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-scope-binding",
      steps: [
        {
          id: "extract_projects",
          kind: "transform",
          language: "javascript",
          expression: "return ['alpha', 'beta', 'gamma'];",
        },
        {
          id: "iter",
          kind: "loop",
          over: "$scope.extract_projects.data",
          body: ["body"],
        },
        {
          id: "body",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$item;",
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
          body: ["body"],
        },
        {
          id: "body",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$item * 2;",
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

  test("bare-path form `extract_projects.data` still works", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-bare-path",
      steps: [
        {
          id: "extract_projects",
          kind: "transform",
          language: "javascript",
          expression: "return ['a', 'b'];",
        },
        {
          id: "iter",
          kind: "loop",
          over: "extract_projects.data",
          body: ["body"],
        },
        {
          id: "body",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$item;",
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
          language: "javascript",
          expression: "return { tier: 'enterprise' };",
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
          language: "javascript",
          expression: "return 'ENTERPRISE';",
        },
        {
          id: "self_serve_path",
          kind: "transform",
          language: "javascript",
          expression: "return 'SELF_SERVE';",
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
          language: "javascript",
          expression: "return 'YES';",
        },
        {
          id: "no",
          kind: "transform",
          language: "javascript",
          expression: "return 'NO';",
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
