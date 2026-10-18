import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("request-media-type");
});

afterAll(async () => {
  await ctx?.cleanup();
});

test("workflow JSON routes reject an unsupported media type", async () => {
  const response = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "text/plain" },
    body: "{}",
  });
  expect(response.status).toBe(415);
  expect(await response.json()).toMatchObject({
    code: "unsupported_media_type",
    message: "Unsupported request Content-Type",
    trace_id: expect.any(String),
  });
});

test("supported JSON still receives schema validation", async () => {
  const response = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: "{}",
  });
  expect(response.status).toBe(400);
});

test("authentication remains required before request validation", async () => {
  const response = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  expect(response.status).toBe(401);
});

test("a malformed JSON body is a client error with a stable code", async () => {
  for (const path of ["/v1/agent/domains", "/v1/workflows"]) {
    const response = await fetch(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: '{"domains": [',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "malformed_json",
      message: "Malformed JSON in request body",
      trace_id: expect.any(String),
    });
  }
});
