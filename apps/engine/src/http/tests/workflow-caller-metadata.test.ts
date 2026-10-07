import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getWorkflow } from "../../workflows/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_caller_metadata");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("public workflow caller metadata persistence", () => {
  test("retains product, caller kind and privacy through HTTP creation", async () => {
    const metadata = {
      product_id: "integration-spike",
      required_caller_kind: "user",
      execution_privacy: "sensitive",
    };
    const response = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "caller-metadata-echo",
        ...metadata,
        steps: [{ kind: "transform", id: "out", expression: "return input.input;" }],
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const stored = await getWorkflow(ctx.tenantId, created.id, ctx.db);
    expect(stored?.definition).toMatchObject(metadata);
  });
});
