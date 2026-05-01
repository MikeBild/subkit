// Topological execution at runtime — a step that references
// `$scope.<id>.data` runs AFTER `<id>` even when declared earlier.
// Cycles are caught at authoring time; this test pins the runtime
// ordering for forward-reference workflows.

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
    // s1 references s2's output. Declared first → naive linear walk
    // would see undefined. Topo sort runs s2 first.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "forward-ref",
      steps: [
        {
          id: "s1",
          kind: "transform",
          language: "jsonata",
          expression: "$scope.s2.data * 2",
        },
        {
          id: "s2",
          kind: "transform",
          language: "jsonata",
          expression: "21",
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
    // The step summary indices reflect declaration order; the
    // succeeded outputs prove the runtime walked s2 first.
    const s1Summary = result.steps.find((s) => s.step_key === "s1");
    const s2Summary = result.steps.find((s) => s.step_key === "s2");
    expect(s1Summary?.status).toBe("succeeded");
    expect(s2Summary?.status).toBe("succeeded");
  });

  test("linear declaration-ordered workflow keeps array order", async () => {
    // No cross-refs → topo equals array order. Confirms zero behaviour
    // change for the common case.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "linear-order",
      steps: [
        { id: "a", kind: "transform", language: "jsonata", expression: "1" },
        { id: "b", kind: "transform", language: "jsonata", expression: "2" },
        { id: "c", kind: "transform", language: "jsonata", expression: "3" },
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
    // s1 -> s2 -> s3, declared in reverse. Topo must produce s3, s2, s1.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "reverse-chain",
      steps: [
        {
          id: "s1",
          kind: "transform",
          language: "jsonata",
          expression: "$scope.s2.data + 1",
        },
        {
          id: "s2",
          kind: "transform",
          language: "jsonata",
          expression: "$scope.s3.data * 10",
        },
        {
          id: "s3",
          kind: "transform",
          language: "jsonata",
          expression: "5",
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
    // s3 → 5; s2 → 50; s1 → 51. Topo sort makes the math right.
    expect(result.output).toBe(51);
  });
});
