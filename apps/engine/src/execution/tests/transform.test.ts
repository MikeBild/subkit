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
  test("transform projects request output via JSONata", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "fetch-and-shape",
      steps: [
        { kind: "request", id: "users", method: "GET", url: `${mock.baseUrl}/users` },
        {
          kind: "transform",
          id: "names",
          expression: "users.data.name",
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

  test("loop body transform sees `letter` and `$loop_index` bindings", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-bindings",
      steps: [
        { kind: "transform", id: "letters", expression: "['a', 'b', 'c']" },
        { kind: "loop", id: "iter", over: "letters.data", item_var: "letter", body: ["tag"] },
        {
          kind: "transform",
          id: "tag",
          expression: "{ 'index': $loop_index, 'letter': letter }",
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
    // Reproduces the session-79bf2cca pattern: the loop driver resolves
    // 3 items, every body step "succeeds", but each body produces an
    // empty array — so the user sees "succeeded" with no rows. The
    // engine must surface a structured `loop_body_empty` warning so
    // the run_workflow tool downgrades to partial_success and the LLM
    // gets the actual scope shape.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "empty-loop-body",
      steps: [
        { kind: "transform", id: "items", expression: "['a', 'b', 'c']" },
        { kind: "loop", id: "iter", over: "items.data", item_var: "item", body: ["empty"] },
        // Body step returns an empty array — body succeeds, but no row.
        { kind: "transform", id: "empty", expression: "[]" },
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

  test("empty-extraction warning carries the real upstream paths to copy", async () => {
    // A transform that references a path that does not resolve produces
    // an empty result. The warning must not just say "wrong path" — it
    // must hand the author the ACTUAL `$scope.<step>.data.<path>`
    // candidates walked from the live upstream payload, so the fix is a
    // copy-paste rather than the dozen-turn guessing spiral.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "empty-extraction-paths",
      steps: [
        {
          kind: "transform",
          id: "source",
          expression: "{ 'chargers': { 'edges': [ { 'node': { 'id': 'c1' } } ] } }",
        },
        // `.chargers.items` does not exist — the real path is
        // `.chargers.edges`.
        { kind: "transform", id: "filter_bad", expression: "$scope.source.data.chargers.items" },
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
    const empty = warnings.find((w) => w.code === "transform_empty_extraction");
    expect(empty).toBeDefined();
    expect(empty?.identifier).toBe("filter_bad");
    const paths = (empty?.details as { available_paths?: string[] } | undefined)?.available_paths;
    expect(paths).toBeDefined();
    expect(paths).toContain("$scope.source.data.chargers.edges");
    // The real path is also quoted in the human-readable message.
    expect(empty?.message).toContain("$scope.source.data.chargers.edges");
  });

  test("loop with at least one productive iteration does not emit loop_body_empty", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "productive-loop-body",
      steps: [
        { kind: "transform", id: "items", expression: "['a', 'b', 'c']" },
        { kind: "loop", id: "iter", over: "items.data", item_var: "item", body: ["pick"] },
        // Returns a real value for every iteration → no warning.
        { kind: "transform", id: "pick", expression: "item" },
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
