import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx!: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("jsonata-bindings-uniform");
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx?.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

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
