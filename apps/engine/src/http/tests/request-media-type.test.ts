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
