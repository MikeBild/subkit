import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runDocumentAnalysisFlow } from "../../llm/flows/document-analysis.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;

const STRIPE_OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Stripe API", version: "2024-06-20" },
  paths: {
    "/v1/charges": {
      get: {
        summary: "List charges",
        responses: { "200": { description: "ok" }, "400": { description: "bad request" } },
      },
      post: {
        summary: "Create charge",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { amount: { type: "integer" }, currency: { type: "string" } },
                required: ["amount", "currency"],
              },
            },
          },
        },
        responses: { "200": { description: "ok" }, "402": { description: "payment required" } },
      },
    },
    "/v1/charges/{id}": {
      get: {
        summary: "Retrieve charge",
        parameters: [{ name: "id", in: "path", required: true }],
        responses: { "200": { description: "ok" }, "404": { description: "not found" } },
      },
    },
  },
});

beforeAll(async () => {
  ctx = await createJourneyCtx("openapi-to-workflow");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("44: OpenAPI → workflow (deterministic parser)", () => {
  test("AC1: parses endpoints from OpenAPI JSON, no LLM call", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://stripe-openapi",
          mime_type: "application/json",
          filename: "stripe-openapi.json",
          content: STRIPE_OPENAPI,
        },
      ],
      goal: "process a payment",
    });

    expect(result.errors).toHaveLength(0);
    expect(result.source_format).toBe("openapi");
    expect(result.endpoints.length).toBeGreaterThanOrEqual(3);
  });

  test("AC2: confidence ≥ 90 for OpenAPI structured format", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://stripe-openapi",
          mime_type: "application/json",
          filename: "stripe.json",
          content: STRIPE_OPENAPI,
        },
      ],
    });

    expect(result.confidence).toBeGreaterThanOrEqual(90);
  });

  test("AC3: endpoints have method, path, expected_statuses, idempotent", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://stripe-openapi",
          mime_type: "application/json",
          filename: "stripe.json",
          content: STRIPE_OPENAPI,
        },
      ],
    });

    const listCharges = result.endpoints.find(
      (e) => e.method === "GET" && e.path === "/v1/charges",
    );
    expect(listCharges).toBeDefined();
    expect(listCharges!.idempotent).toBe(true);
    expect(listCharges!.expected_statuses).toContain(200);

    const createCharge = result.endpoints.find(
      (e) => e.method === "POST" && e.path === "/v1/charges",
    );
    expect(createCharge).toBeDefined();
    expect(createCharge!.idempotent).toBe(false);
    expect(createCharge!.request_schema).toBeDefined();
    expect(createCharge!.expected_statuses).toContain(200);
  });

  test("AC4: multiple attachments merged, no duplicate method+path", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://stripe-a",
          mime_type: "application/json",
          filename: "stripe-a.json",
          content: STRIPE_OPENAPI,
        },
        {
          storage_uri: "memory://stripe-b",
          mime_type: "application/json",
          filename: "stripe-b.json",
          content: STRIPE_OPENAPI,
        },
      ],
    });

    const listCount = result.endpoints.filter(
      (e) => e.method === "GET" && e.path === "/v1/charges",
    ).length;
    expect(listCount).toBe(1);
  });
});
