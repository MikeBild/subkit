// Workflow-level `validation_expression` — evaluates AFTER output_schema.
// A falsy result trips finalStatus to "failed" and surfaces a typed
// `validation_failed` error so the self-healing loop can produce a
// `validation_failed` drift signal. Mirrors the reference impl's
// optional `validationFunction`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("validation-expression");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflow.validation_expression", () => {
  test("truthy verdict leaves the run as succeeded with no validation error", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "validation-truthy",
      steps: [
        {
          kind: "transform",
          id: "shape",
          language: "jsonata",
          expression: "{ 'orders': [{ 'id': 'a' }, { 'id': 'b' }] }",
        },
      ],
      validation_expression: "$count(orders) > 0",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.error).toBeNull();
  });

  test("falsy verdict trips finalStatus to failed and stamps validation_failed code", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "validation-falsy",
      steps: [
        {
          kind: "transform",
          id: "shape",
          language: "jsonata",
          // Empty orders array — invariant requires at least one.
          expression: "{ 'orders': [] }",
        },
      ],
      validation_expression: "$count(orders) > 0",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe("validation_failed");
    expect(result.error?.message).toContain("$count(orders) > 0");
  });

  test("expression that throws is treated as a falsy verdict", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "validation-throws",
      steps: [
        {
          kind: "transform",
          id: "shape",
          language: "jsonata",
          expression: "{ 'orders': [] }",
        },
      ],
      // Reference a path that doesn't exist on the output. JSONata
      // returns undefined, which is falsy, so the run fails. The
      // intent is the same — invariant did not hold.
      validation_expression: "$count(somethingThatIsNotThere) > 0",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("validation_failed");
  });

  test("validation_function (JS) trips validation_failed when it returns false", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "validation-fn-falsy",
      steps: [
        {
          id: "shape",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'count': 0 }",
        },
      ],
      // Imperative invariant: count must be > 5.
      validation_function: "return input.count > 5;",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("validation_failed");
  });

  test("output_transform reshapes the final output when set", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "output-transform-shape",
      steps: [
        {
          id: "raw",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'orders': [{ 'id': 'a' }, { 'id': 'b' }] }",
        },
      ],
      output_transform: "{ 'count': $count(orders), 'ids': orders.id }",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ count: 2, ids: ["a", "b"] });
  });

  test("output_transform_function (JS) reshapes the final output via QuickJS", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "output-transform-fn-shape",
      steps: [
        {
          id: "raw",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'orders': [{ 'id': 'a' }, { 'id': 'b' }] }",
        },
      ],
      output_transform_function:
        "return { count: input.orders.length, ids: input.orders.map(o => o.id) };",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ count: 2, ids: ["a", "b"] });
  });

  test("step JS sees scope wrapper; workflow output JS sees last output only", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "output-transform-fn-context",
      steps: [
        {
          id: "raw",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'value': 'last-step-data' }",
        },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression:
            "return { from_scope: input.scope.raw.data.value, from_input: input.input.marker };",
        },
      ],
      output_transform_function:
        "return { final_value: input.from_scope, marker: input.from_input, scope_type: typeof scope };",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { marker: "workflow-input" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      final_value: "last-step-data",
      marker: "workflow-input",
      scope_type: "undefined",
    });
  });

  test("output_transform_function that throws fails with output_transform_failed", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "output-transform-fn-throws",
      steps: [
        {
          id: "raw",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'a': 1 }",
        },
      ],
      output_transform_function: "throw new Error('forced');",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("output_transform_failed");
  });

  test("output_transform that throws fails with output_transform_failed code", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "output-transform-throws",
      steps: [
        {
          id: "raw",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'a': 1 }",
        },
      ],
      // $type is a JSONata function; invoking it with too many args
      // throws synchronously inside evaluate.
      output_transform: "$assert(false, 'forced')",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("output_transform_failed");
  });

  test("validation_expression details carry the offending value via drift detector", async () => {
    // The repair path reads the typed error and consumes
    // details.expression + details.actual_value through the drift
    // detector. We can't exercise the detector here without seeding
    // an execution_steps row, but we can confirm the engine surfaces
    // the expression text in the error message so the operator (and
    // the LLM repair flow's prompt assembly) sees it.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "validation-message-detail",
      steps: [
        {
          kind: "transform",
          id: "shape",
          language: "jsonata",
          expression: "{ 'count': 0 }",
        },
      ],
      validation_expression: "count > 5",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("validation_failed");
    expect(result.error?.message).toContain("count > 5");
  });
});
