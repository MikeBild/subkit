// Contract: a `RequestError(cause_kind: "request_invalid")` — the
// taxonomy entry produced when the http driver throws
// `HttpRequestInvalidError` for a malformed plan (non-RFC-7230 header
// name, JSON-string-pretending-to-be-headers slipthrough, non-string
// header value) — must NOT be retried. Retries can't fix a malformed
// plan; without an explicit no-retry classification the failure used
// to reclassify as `connection` and burn 5 retries on every misformed
// request.
//
// Drives executeRequestStep through the engine harness with a header
// name that fails RFC 7230 token validation. Asserts the workflow
// fails on the first attempt — total upstream hits is 0 (the http
// driver never reaches fetch).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let attempts = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("request-invalid-no-retry");
  mock = await createMockServer((_, res) => {
    attempts += 1;
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request_invalid · no retry", () => {
  test("malformed header name throws once, no retry, no upstream hit", async () => {
    attempts = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "no-retry-on-bad-header",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
          // RFC 7230 token violations: space + colon are not allowed
          // in field-name. The schema-level guard at parseHeaderLines
          // catches the clearly-broken JSON-string slipthrough; an
          // object-shaped headers map with an invalid key reaches
          // the http driver's validateOutboundHeaders which throws
          // HttpRequestInvalidError, classified as `request_invalid`
          // and never retried.
          headers: { "Bad Header": "value" },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(attempts).toBe(0);
  });
});
