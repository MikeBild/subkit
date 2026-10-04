import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("output_transform_scope_binding");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("output_transform sees $scope + $input", () => {
  test("object-constructor transform over $scope.<step>.data returns real data, not {}", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "shape-from-scope",
      steps: [
        {
          id: "render",
          kind: "transform",
          language: "javascript",
          expression: 'return { slug: "why-x", title: "Why X" };',
        },
        { id: "tag", kind: "transform", language: "javascript", expression: "return { n: 42 };" },
      ],
      output_transform:
        '{ "slug": $scope.render.data.slug, "title": $scope.render.data.title, "n": $scope.tag.data.n }',
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ slug: "why-x", title: "Why X", n: 42 });
  });

  test("output_transform can reference $input", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "echo-input",
      steps: [
        {
          id: "noop",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
      ],
      output_transform: '{ "echoed": $input.page_id, "from_scope": $scope.noop.data.page_id }',
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { page_id: "abc-123" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ echoed: "abc-123", from_scope: "abc-123" });
  });

  test("validation_expression over $scope passes when the referenced field is present", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "validate-from-scope",
      steps: [
        {
          id: "render",
          kind: "transform",
          language: "javascript",
          expression: 'return { slug: "ok" };',
        },
      ],
      validation_expression: "$scope.render.data.slug = 'ok'",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
  });
});
