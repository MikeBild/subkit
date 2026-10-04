import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executionSteps } from "../../db/schema/index.ts";
import type { RequestStep, StepDef, TransformStep } from "../../workflows/types.ts";
import { resolveForEachConcurrency, runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

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
          language: "javascript",
          expression: 'return [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}];',
        },
        {
          id: "process_item",
          kind: "transform",
          language: "javascript",
          expression:
            "return { doubled: input.scope.$loop_index * 2, name: input.scope.$item.name };",
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
      (processStep!.output_preview as Array<Record<string, unknown>> | undefined) ?? [];
    expect(scopeData).toHaveLength(2);
  });

  test("$item and $loop_index are accessible in iterations", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-bindings",
      steps: [
        {
          id: "source",
          kind: "transform",
          language: "javascript",
          expression: 'return ["x", "y", "z"];',
        },
        {
          id: "tagged",
          kind: "transform",
          language: "javascript",
          expression: 'return input.scope.$item + "_" + String(input.scope.$loop_index);',
          for_each: "(sourceData) => sourceData.source.data",
        },
        {
          id: "final",
          kind: "transform",
          language: "javascript",
          expression: "return (input.scope.tagged.data || []).length;",
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
          language: "javascript",
          expression: 'return {"items": [1, 2]};',
        },
        {
          id: "iterated",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$item;",
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
          language: "javascript",
          expression: "return input.scope.$item * 10;",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
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
          language: "javascript",
          expression: 'return "then";',
        },
        {
          id: "else_step",
          kind: "transform",
          language: "javascript",
          expression: 'return "else";',
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
    const thenStep = result.steps.find((s) => s.step_key === "then_step");
    expect(thenStep?.status).toBe("succeeded");
    const elseStep = result.steps.find((s) => s.step_key === "else_step");
    if (elseStep) {
      expect(elseStep.status).toBe("skipped");
    }
  });
});

describe("for_each · container execution_steps row finalization", () => {
  test("container row reaches a terminal status after successful iteration", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-row-finalize",
      steps: [
        {
          id: "items",
          kind: "transform",
          language: "javascript",
          expression: "return [1, 2, 3];",
        },
        {
          id: "doubled",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$item * 2;",
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
    const rows = await ctx.testDb.db
      .select({ step_key: executionSteps.step_key, status: executionSteps.status })
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    const containerRow = rows.find((r) => r.step_key === "doubled");
    expect(containerRow).toBeDefined();
    expect(containerRow?.status).toBe("succeeded");
  });

  test("container row reaches a terminal status when selector returns empty", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-row-empty",
      steps: [
        {
          id: "src",
          kind: "transform",
          language: "javascript",
          expression: 'return "not_an_array";',
        },
        {
          id: "proc",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$item;",
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

describe("resolveForEachConcurrency · auto-selection from side-effect class", () => {
  const get = (over: Record<string, unknown> = {}): StepDef =>
    ({ id: "s", kind: "request", method: "GET", ...over }) as RequestStep as StepDef;
  const post = (over: Record<string, unknown> = {}): StepDef =>
    ({ id: "s", kind: "request", method: "POST", ...over }) as RequestStep as StepDef;
  const transform = (over: Record<string, unknown> = {}): StepDef =>
    ({
      id: "s",
      kind: "transform",
      language: "javascript",
      expression: "return 1;",
      ...over,
    }) as TransformStep as StepDef;

  test("read-classified request fans out at the default bound, clamped to item count", () => {
    expect(resolveForEachConcurrency(get(), 50)).toBe(8);
    expect(resolveForEachConcurrency(get(), 5)).toBe(5);
  });

  test("write-classified request stays sequential", () => {
    expect(resolveForEachConcurrency(post(), 50)).toBe(1);
  });

  test("non-request (transform) body stays sequential", () => {
    expect(resolveForEachConcurrency(transform(), 50)).toBe(1);
  });

  test("explicit side_effects override flips the class", () => {
    expect(resolveForEachConcurrency(get({ side_effects: "write" }), 50)).toBe(1);
    expect(resolveForEachConcurrency(post({ side_effects: "read" }), 50)).toBe(8);
  });

  test("explicit for_each_concurrency always wins, clamped to item count", () => {
    expect(resolveForEachConcurrency(get({ for_each_concurrency: 3 }), 50)).toBe(3);
    expect(resolveForEachConcurrency(transform({ for_each_concurrency: 4 }), 50)).toBe(4);
    expect(resolveForEachConcurrency(post({ for_each_concurrency: 100 }), 50)).toBe(50);
    expect(resolveForEachConcurrency(get({ for_each_concurrency: 1 }), 50)).toBe(1);
  });

  test("single-item (or empty) collections never parallelize", () => {
    expect(resolveForEachConcurrency(get(), 1)).toBe(1);
    expect(resolveForEachConcurrency(get(), 0)).toBe(1);
  });
});

describe("for_each · bounded-parallel iteration preserves order", () => {
  test("explicit concurrency over a transform body keeps results index-ordered", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-parallel-order",
      steps: [
        {
          id: "src",
          kind: "transform",
          language: "javascript",
          expression: "return [10, 11, 12, 13, 14, 15];",
        },
        {
          id: "proc",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$loop_index;",
          for_each: "(sourceData) => sourceData.src.data",
          for_each_concurrency: 4,
        },
        {
          id: "collect",
          kind: "transform",
          language: "javascript",
          expression: "return (input.scope.proc.data || []).map((e) => e.proc.data);",
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
    expect(result.output).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("auto-parallelizes read-classified request bodies", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const mock: MockServer = await createMockServer(async (_, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (maxActive > 1) releaseGate?.();
      await gate;
      active -= 1;
      jsonResponse(res, 200, { ok: true });
    });
    try {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "for-each-auto-request-concurrency",
        steps: [
          {
            id: "src",
            kind: "transform",
            language: "javascript",
            expression: "return [1, 2, 3, 4, 5, 6];",
          },
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            url: `${mock.baseUrl}/data`,
            for_each: "(sourceData) => sourceData.src.data",
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
      expect(maxActive).toBeGreaterThan(1);
    } finally {
      await mock.close();
    }
  }, 15000);
});
