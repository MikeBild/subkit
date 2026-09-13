// GC6 — /v1/ai/extract 100 MB body cap.
//
// The route enforces the cap in two places:
//   1. `content-length` header exceeds the cap -> 413 without reading
//      the body.
//   2. Missing / lying `content-length` -> the route streams the body
//      and bails once aggregated bytes cross the cap.
//
// A 1 KB happy-path request is covered to prove the cap does not
// disturb normal traffic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { resetMockProvider } from "../../llm/mock-provider.ts";
import { EXTRACT_BODY_CAP_BYTES } from "../routes/ai/extract.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("extract-cap");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("http /v1/ai/extract body cap", () => {
  test("a 1 KB body passes the cap middleware", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/ai/extract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${srv.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sample: "id,name\n1,alice\n2,bob\n" }),
    });
    // The mock provider handles extract flows in-process so the 1 KB
    // request should return 200. What matters for this test is that
    // 413 is NOT raised on the small body.
    expect(res.status).not.toBe(413);
  });

  test("a body above 100 MB is rejected with 413", async () => {
    // Build a synthetic JSON payload whose serialized length exceeds
    // the 100 MB cap by at least one byte. We pad with ASCII 'a' so
    // `JSON.stringify` adds no escapes and the byte count is exact.
    // The wrapper `{"sample":"..."}` contributes 12 bytes of overhead.
    const overhead = '{"sample":""}'.length;
    const padding = "a".repeat(EXTRACT_BODY_CAP_BYTES + 1 - overhead);
    const body = JSON.stringify({ sample: padding });
    // Sanity: the serialized body must exceed the cap for the test to
    // exercise the rejection path.
    expect(body.length).toBeGreaterThan(EXTRACT_BODY_CAP_BYTES);

    const res = await fetch(`${srv.baseUrl}/v1/ai/extract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${srv.apiKey}`,
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    });
    expect(res.status).toBe(413);
    const envelope = (await res.json()) as { code: string };
    expect(envelope.code).toBe("payload_too_large");
  }, 30000);
});
