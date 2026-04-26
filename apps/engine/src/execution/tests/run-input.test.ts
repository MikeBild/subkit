import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("run-input");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("runExecution input normalization", () => {
  test("accepts a stringified object payload across the shared execution path", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "stringified-input",
      slug: "stringified-input",
      input_schema: {
        type: "object",
        required: ["date"],
        properties: {
          date: { type: "string" },
        },
      },
      steps: [
        {
          kind: "transform",
          id: "shape",
          expression: "$input.date",
          language: "jsonata",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: '{"date":"tomorrow +1"}',
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("tomorrow +1");
  });
});
