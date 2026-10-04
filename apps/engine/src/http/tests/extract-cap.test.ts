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
    expect(res.status).not.toBe(413);
  });

  test("a body above 100 MB is rejected with 413", async () => {
    const overhead = '{"sample":""}'.length;
    const padding = "a".repeat(EXTRACT_BODY_CAP_BYTES + 1 - overhead);
    const body = JSON.stringify({ sample: padding });
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
