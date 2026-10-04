import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;

beforeAll(async () => {
  ctx = await createEngineCtx("transform");
  mock = await createMockServer((_, res) =>
    jsonResponse(res, 200, [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]),
  );
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request + transform", () => {
  test("transform projects request output via a JS body", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "fetch-and-shape",
      steps: [
        { kind: "request", id: "users", method: "GET", url: `${mock.baseUrl}/users` },
        {
          kind: "transform",
          id: "names",
          language: "javascript",
          expression: "return (input.scope.users.data || []).map((u) => u.name);",
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
    expect(result.output).toEqual(["a", "b"]);
  });

  test("loop body transform sees `$item` and `$loop_index` bindings", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-bindings",
      steps: [
        {
          kind: "transform",
          id: "letters",
          language: "javascript",
          expression: "return ['a', 'b', 'c'];",
        },
        { kind: "loop", id: "iter", over: "letters.data", body: ["tag"] },
        {
          kind: "transform",
          id: "tag",
          language: "javascript",
          expression: "return { index: input.scope.$loop_index, letter: input.scope.$item };",
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
    const out = result.output as Array<{ tag: { data: { index: number; letter: string } } }>;
    expect(out).toHaveLength(3);
    expect(out[0]?.tag.data).toEqual({ index: 0, letter: "a" });
    expect(out[1]?.tag.data).toEqual({ index: 1, letter: "b" });
    expect(out[2]?.tag.data).toEqual({ index: 2, letter: "c" });
  });

  test("loop with N iterations but no productive body emits loop_body_empty warning", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "empty-loop-body",
      steps: [
        {
          kind: "transform",
          id: "items",
          language: "javascript",
          expression: "return ['a', 'b', 'c'];",
        },
        { kind: "loop", id: "iter", over: "items.data", body: ["empty"] },
        { kind: "transform", id: "empty", language: "javascript", expression: "return [];" },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const warnings = result.warnings ?? [];
    const empty = warnings.find((w) => w.code === "loop_body_empty");
    expect(empty).toBeDefined();
    expect(empty?.identifier).toBe("iter");
    const details = empty?.details as
      | {
          iterations: number;
          productive_iterations: number;
          body_step_ids: string[];
          example_path: string;
        }
      | undefined;
    expect(details?.iterations).toBe(3);
    expect(details?.productive_iterations).toBe(0);
    expect(details?.body_step_ids).toEqual(["empty"]);
    expect(details?.example_path).toBe("$scope.iter.data[0].empty.data");
  });

  test("step_output_fixtures short-circuits the upstream and feeds downstream from cached envelope", async () => {
    let fetchCount = 0;
    const counterMock = await createMockServer((_, res) => {
      fetchCount++;
      return jsonResponse(res, 200, [
        { id: "X", name: "from_origin" },
        { id: "Y", name: "second_row" },
      ]);
    });
    try {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "fixture-replay",
        steps: [
          { kind: "request", id: "users", method: "GET", url: `${counterMock.baseUrl}/users` },
          {
            kind: "transform",
            id: "names",
            language: "javascript",
            expression: "return (input.scope.users.data || []).map((u) => u.name);",
          },
        ],
      });
      const r1 = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });
      expect(r1.status).toBe("succeeded");
      expect(fetchCount).toBe(1);
      const usersStep = r1.steps.find((s) => s.step_key === "users");
      expect(usersStep?.output_preview).toBeDefined();
      const rm = usersStep?.request_meta as { status?: number } | null | undefined;
      const envelope = {
        data: usersStep?.output_preview,
        duration_ms: usersStep?.duration_ms ?? 0,
        error: usersStep?.error ?? null,
        ...(typeof rm?.status === "number" ? { status_code: rm.status } : {}),
      };
      const r2 = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
        options: { step_output_fixtures: { users: envelope } },
      });
      expect(r2.status).toBe("succeeded");
      expect(r2.output).toEqual(["from_origin", "second_row"]);
      expect(fetchCount).toBe(1);
    } finally {
      await counterMock.close();
    }
  });

  test("loop with at least one productive iteration does not emit loop_body_empty", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "productive-loop-body",
      steps: [
        {
          kind: "transform",
          id: "items",
          language: "javascript",
          expression: "return ['a', 'b', 'c'];",
        },
        { kind: "loop", id: "iter", over: "items.data", body: ["pick"] },
        {
          kind: "transform",
          id: "pick",
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
    const warnings = result.warnings ?? [];
    expect(warnings.find((w) => w.code === "loop_body_empty")).toBeUndefined();
  });
});
