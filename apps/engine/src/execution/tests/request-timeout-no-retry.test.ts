// Contract: a per-request TIMEOUT (`AbortSignal.timeout` →
// DOMException `TimeoutError`, message "The operation timed out.") must
// be classified as a terminal `timeout` and NOT retried.
//
// Pre-fix the timeout error shape was not recognised by the
// abort/timeout detector in `dispatch.ts` (it checked only `AbortError`
// + `/abort/i`), so it fell through to the connection-error branch and
// was retried "regardless of method". A Gmail `POST /messages/send`
// that stalled for the full 300s budget was therefore retried 5×
// (~23 min wall clock) AND risked double-sending the email
// (production: workflow 18bfde85 send_email, 2026-06-21).
//
// Behavioural (DB + mock server): a POST whose response never arrives
// within `timeout_ms` hits the upstream exactly ONCE. The no-DB
// source-level contract for the same fix lives in
// request-retry-telemetry.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let attempts = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("request-timeout-no-retry");
  // Handler that NEVER responds: the request hangs until the step's
  // `timeout_ms` fires on the client side (no setTimeout — the
  // determinism linter forbids it in tests). Each connection bumps the
  // counter so we can assert no-retry.
  mock = await createMockServer((_req, res) => {
    attempts += 1;
    void res; // leave the response open; the client aborts on timeout.
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request_timeout · no retry", () => {
  test("a POST that times out hits upstream exactly once and fails", async () => {
    attempts = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "no-retry-on-timeout",
      steps: [
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          headers: { "Content-Type": "application/json" },
          body: { hello: "world" },
          // Tiny budget so the client aborts well before the 5s server reply.
          timeout_ms: 250,
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
    // The crux: a non-idempotent POST timeout is NOT retried, so the
    // upstream saw the request exactly once (no double-send).
    expect(attempts).toBe(1);
  });
});
