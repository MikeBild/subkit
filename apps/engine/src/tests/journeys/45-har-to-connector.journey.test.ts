// User story: As an operator, I want to upload a HAR file and have the engine
// extract real HTTP traffic endpoints deterministically, so that I can build
// a connector from observed API traffic without writing specs by hand.
//
// Acceptance criteria:
//   - AC1: `runDocumentAnalysisFlow` parses a HAR file and extracts endpoints.
//   - AC2: Multiple entries for the same method+path are deduplicated, and all
//          observed status codes are merged into `expected_statuses`.
//   - AC3: POST entries with JSON postData produce a `request_schema`.
//   - AC4: `source_format` is "har" and `confidence` is ≥ 90.
// Spec refs: plan docs — Approach 2, Tier 1 HAR parser

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runDocumentAnalysisFlow } from "../../llm/flows/document-analysis.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;

const EXAMPLE_HAR = JSON.stringify({
  log: {
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/v1/charges",
          headers: [],
        },
        response: { status: 200, content: { mimeType: "application/json" } },
      },
      {
        request: {
          method: "POST",
          url: "https://api.example.com/v1/charges",
          headers: [],
          postData: {
            mimeType: "application/json",
            text: JSON.stringify({ amount: 1000, currency: "usd" }),
          },
        },
        response: { status: 200, content: {} },
      },
      // Duplicate GET /v1/charges with a different status — should be merged.
      {
        request: {
          method: "GET",
          url: "https://api.example.com/v1/charges",
          headers: [],
        },
        response: { status: 404, content: {} },
      },
      {
        request: {
          method: "GET",
          url: "https://api.example.com/v1/charges/ch_123",
          headers: [],
        },
        response: { status: 200, content: {} },
      },
    ],
  },
});

beforeAll(async () => {
  ctx = await createJourneyCtx("har-to-connector");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("45: HAR → connector endpoint extraction (deterministic parser)", () => {
  test("AC1: parses endpoints from HAR, no LLM call", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://example-har",
          mime_type: "application/json",
          filename: "example.har",
          content: EXAMPLE_HAR,
        },
      ],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.source_format).toBe("har");
    expect(result.endpoints.length).toBeGreaterThanOrEqual(3);
  });

  test("AC2: duplicate method+path entries are merged; statuses accumulated", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://example-har",
          mime_type: "application/json",
          filename: "example.har",
          content: EXAMPLE_HAR,
        },
      ],
    });

    // Exactly one GET /v1/charges (not two)
    const getCharges = result.endpoints.filter(
      (e) => e.method === "GET" && e.path === "/v1/charges",
    );
    expect(getCharges).toHaveLength(1);

    // Both observed statuses (200 and 404) should be in expected_statuses.
    expect(getCharges[0]!.expected_statuses).toContain(200);
    expect(getCharges[0]!.expected_statuses).toContain(404);
  });

  test("AC3: POST entry with JSON postData produces request_schema", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://example-har",
          mime_type: "application/json",
          filename: "example.har",
          content: EXAMPLE_HAR,
        },
      ],
    });

    const postCharges = result.endpoints.find(
      (e) => e.method === "POST" && e.path === "/v1/charges",
    );
    expect(postCharges).toBeDefined();
    expect(postCharges!.request_schema).toBeDefined();
    const props = (postCharges!.request_schema as { properties?: Record<string, unknown> })
      ?.properties;
    expect(props).toHaveProperty("amount");
    expect(props).toHaveProperty("currency");
  });

  test("AC4: source_format is 'har' and confidence ≥ 90", async () => {
    const result = await runDocumentAnalysisFlow({
      tenant_id: ctx.tenantId,
      attachments: [
        {
          storage_uri: "memory://example-har",
          mime_type: "application/json",
          filename: "example.har",
          content: EXAMPLE_HAR,
        },
      ],
    });

    expect(result.source_format).toBe("har");
    expect(result.confidence).toBeGreaterThanOrEqual(90);
  });
});
