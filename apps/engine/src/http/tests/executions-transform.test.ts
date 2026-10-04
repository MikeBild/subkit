import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("exec_transform");
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = (apiKey: string): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
});

async function callTransform(body: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${ctx.baseUrl}/v1/executions/transform`, {
    method: "POST",
    headers: headers(ctx.apiKey),
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: out };
}

describe("POST /v1/executions/transform", () => {
  test("applies a JSONata output_transform to the payload", async () => {
    const r = await callTransform({
      payload: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      output_transform: "$count(items)",
    });
    expect(r.status).toBe(200);
    expect(r.body.output).toBe(3);
    expect(typeof r.body.duration_ms).toBe("number");
  });

  test("applies a JS output_transform_function via QuickJS sandbox", async () => {
    const r = await callTransform({
      payload: { count: 7 },
      output_transform_function: "return input.count * 2",
    });
    expect(r.status).toBe(200);
    expect(r.body.output).toBe(14);
  });

  test("MASK response_filter masks PII from the transformed output", async () => {
    const r = await callTransform({
      payload: { user: "alice", api_key: "sk-secret" },
      output_transform: "$",
      response_filters: [{ target: "KEYS", action: "MASK", pattern: "^api_key$" }],
    });
    expect(r.status).toBe(200);
    const out = r.body.output as { user: string; api_key: string };
    expect(out.user).toBe("alice");
    expect(out.api_key).toBe("***redacted***");
  });

  test("FAIL response_filter surfaces 422 with response_filter_failed", async () => {
    const r = await callTransform({
      payload: { ssn: "123-45-6789" },
      output_transform: "$",
      response_filters: [{ target: "KEYS", action: "FAIL", pattern: "^ssn$" }],
    });
    expect(r.status).toBe(422);
    expect((r.body as { details?: { code?: string } }).details?.code).toBe(
      "response_filter_failed",
    );
  });

  test("malformed JSONata returns 422 with output_transform_failed", async () => {
    const r = await callTransform({
      payload: { x: 1 },
      output_transform: "$$ INVALID JSONATA $$",
    });
    expect(r.status).toBe(422);
    expect((r.body as { details?: { code?: string } }).details?.code).toBe(
      "output_transform_failed",
    );
  });

  test("rejects body with neither transform nor filters (400 bad_request)", async () => {
    const r = await callTransform({ payload: { a: 1 } });
    expect(r.status).toBe(400);
  });

  test("rejects body with both output_transform and output_transform_function (400)", async () => {
    const r = await callTransform({
      payload: { a: 1 },
      output_transform: "$",
      output_transform_function: "return input",
    });
    expect(r.status).toBe(400);
  });

  test("input_schema required-field violation returns 400 input_schema_violation", async () => {
    const r = await callTransform({
      payload: { a: 1 },
      input_schema: { type: "object", required: ["b"] },
      output_transform: "$",
    });
    expect(r.status).toBe(400);
    expect((r.body as { details?: { code?: string } }).details?.code).toBe(
      "input_schema_violation",
    );
  });

  test("output_schema required-field violation returns 422 output_schema_violation", async () => {
    const r = await callTransform({
      payload: { a: 1 },
      output_schema: { type: "object", required: ["b"] },
      output_transform: "$",
    });
    expect(r.status).toBe(422);
    expect((r.body as { details?: { code?: string } }).details?.code).toBe(
      "output_schema_violation",
    );
  });

  test("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/executions/transform`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: {}, output_transform: "$" }),
    });
    expect(res.status).toBe(401);
  });
});
