import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("result-markdown");
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

async function stored(execution_id: string) {
  const [row] = await ctx.testDb.db
    .select({
      result_markdown: executions.result_markdown,
      result_markdown_truncated: executions.result_markdown_truncated,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, execution_id)));
  return row;
}

async function run(def: Record<string, unknown>) {
  const { workflow_id } = await createWorkflowRow(ctx, def);
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

describe("a finished run keeps its Markdown result", () => {
  test("the result_markdown output field is stored redacted", async () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const result = await run({
      name: "Markdown by convention",
      steps: [
        {
          id: "report",
          kind: "transform",
          expression: `return { ok: true, result_markdown: "# Report\\n\\nKey ${token}" };`,
        },
      ],
    });
    expect(result.status).toBe("succeeded");
    const row = await stored(result.execution_id);
    expect(row?.result_markdown).toStartWith("# Report");
    expect(row?.result_markdown).not.toContain(token);
    expect(row?.result_markdown_truncated).toBe(false);
  });

  test("a field marked text/markdown in output_schema is the result", async () => {
    const result = await run({
      name: "Markdown by declaration",
      output_schema: {
        type: "object",
        properties: { summary: { type: "string", contentMediaType: "text/markdown" } },
      },
      steps: [
        {
          id: "report",
          kind: "transform",
          expression: 'return { summary: "## Done", result_markdown: "ignored" };',
        },
      ],
    });
    expect(result.status).toBe("succeeded");
    expect((await stored(result.execution_id))?.result_markdown).toBe("## Done");
  });

  test("an output without Markdown stores none", async () => {
    const result = await run({
      name: "No Markdown",
      steps: [{ id: "plain", kind: "transform", expression: "return { ok: true };" }],
    });
    expect((await stored(result.execution_id))?.result_markdown).toBeNull();
  });
});
