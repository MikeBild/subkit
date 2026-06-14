import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("executions");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedWorkflow(): Promise<string> {
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: "http-run-input",
      name: "HTTP Run Input",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("seed workflow failed");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "HTTP Run Input",
        slug: "http-run-input",
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
            expression: "return input.input.date;",
            language: "javascript",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("seed workflow version failed");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return workflow.id;
}

describe("http executions route", () => {
  test("normalizes a structured string payload before running the saved workflow", async () => {
    const workflowId = await seedWorkflow();
    const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        input: '{"date":"tomorrow +1"}',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      execution_id: string;
      status: string;
      output: unknown;
    };
    expect(body.execution_id).toBeTruthy();
    expect(body.status).toBe("succeeded");
    expect(body.output).toBe("tomorrow +1");
  });
});
