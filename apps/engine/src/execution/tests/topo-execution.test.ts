import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("topo-execution");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("execution · topological step ordering", () => {
  test("forward ref runs the dependency first even when declared after", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "forward-ref",
      steps: [
        {
          id: "s1",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.s2.data * 2;",
        },
        {
          id: "s2",
          kind: "transform",
          language: "javascript",
          expression: "return 21;",
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
    expect(result.output).toBe(42);
    const s1Summary = result.steps.find((s) => s.step_key === "s1");
    const s2Summary = result.steps.find((s) => s.step_key === "s2");
    expect(s1Summary?.status).toBe("succeeded");
    expect(s2Summary?.status).toBe("succeeded");
  });

  test("linear declaration-ordered workflow keeps array order", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "linear-order",
      steps: [
        { id: "a", kind: "transform", language: "javascript", expression: "return 1;" },
        { id: "b", kind: "transform", language: "javascript", expression: "return 2;" },
        { id: "c", kind: "transform", language: "javascript", expression: "return 3;" },
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
    expect(result.steps.map((s) => s.step_key)).toEqual(["a", "b", "c"]);
  });

  test("transitive forward refs resolve in dependency order", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "reverse-chain",
      steps: [
        {
          id: "s1",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.s2.data + 1;",
        },
        {
          id: "s2",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.s3.data * 10;",
        },
        {
          id: "s3",
          kind: "transform",
          language: "javascript",
          expression: "return 5;",
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
    expect(result.output).toBe(51);
  });
});
