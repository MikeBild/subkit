import { describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { RunBodySchema, RuntimeRunBodySchema } from "./schemas.ts";

const WORKFLOW_ID = "11111111-2222-4333-8444-555555555555";
const savedRun = (idempotencyKey: string) => ({
  workflow_id: WORKFLOW_ID,
  idempotency_key: idempotencyKey,
});
const acceptsKey = (idempotencyKey: string) =>
  [RuntimeRunBodySchema, RunBodySchema].map(
    (schema) => schema.safeParse(savedRun(idempotencyKey)).success,
  );

describe("run idempotency_key length", () => {
  test("counts an astral character as one character like the published maxLength", () => {
    expect(acceptsKey(`${"k".repeat(199)}🚚`)).toStrictEqual([true, true]);
    expect(acceptsKey(`${"k".repeat(199)}é`)).toStrictEqual([true, true]);
    expect(acceptsKey("k".repeat(200))).toStrictEqual([true, true]);
  });

  test("rejects a key above 200 characters and an empty key", () => {
    expect(acceptsKey(`${"k".repeat(200)}🚚`)).toStrictEqual([false, false]);
    expect(acceptsKey("k".repeat(201))).toStrictEqual([false, false]);
    expect(acceptsKey("")).toStrictEqual([false, false]);
  });

  test("the OpenAPI document still publishes minLength 1 and maxLength 200", () => {
    const app = new OpenAPIHono();
    app.openAPIRegistry.registerPath({
      method: "post",
      path: "/run",
      request: { body: { content: { "application/json": { schema: RunBodySchema } } } },
      responses: { 200: { description: "Run" } },
    });
    const document = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "Run contract", version: "1" },
    });
    expect(document.components?.schemas?.ExecutionRunSavedBody).toMatchObject({
      properties: { idempotency_key: { type: "string", minLength: 1, maxLength: 200 } },
    });
  });
});
