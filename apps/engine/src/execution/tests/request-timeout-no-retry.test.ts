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
// Deterministic (DB + driver-fetch seam): the driver egress is replaced
// with a fake that ALWAYS throws a `TimeoutError`, counting calls. A POST
// step that times out must invoke the upstream EXACTLY ONCE — no retry,
// no double-send. Using the seam (not a real client timeout) keeps the
// assertion free of wall-clock flakiness on loaded CI runners.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("request-timeout-no-retry");
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A driver fetch that always times out, counting how often it is hit. */
function makeTimeoutFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fake = ((_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
    calls += 1;
    // Mirror Bun's AbortSignal.timeout rejection shape.
    const err = new Error("The operation timed out.");
    err.name = "TimeoutError";
    return Promise.reject(err);
  }) as unknown as typeof fetch;
  return { fetch: fake, calls: () => calls };
}

describe("request_timeout · no retry", () => {
  test("a POST that times out hits the upstream exactly once and fails", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "no-retry-on-timeout",
      steps: [
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: "http://127.0.0.1:9/send", // never dialled — the seam fake intercepts
          headers: { "Content-Type": "application/json" },
          body: { hello: "world" },
        },
      ],
    });

    const probe = makeTimeoutFetch();
    const result = await withDriverFetchForTests(probe.fetch, () =>
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      }),
    );

    expect(result.status).toBe("failed");
    // The crux: a non-idempotent POST timeout is NOT retried, so the
    // upstream was invoked exactly once (no 5× retry, no double-send).
    expect(probe.calls()).toBe(1);
  });

  test("an idempotent GET that times out is also not retried (terminal)", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "no-retry-on-timeout-get",
      steps: [
        {
          kind: "request",
          id: "read",
          method: "GET",
          url: "http://127.0.0.1:9/read",
        },
      ],
    });

    const probe = makeTimeoutFetch();
    const result = await withDriverFetchForTests(probe.fetch, () =>
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      }),
    );

    expect(result.status).toBe("failed");
    // A timeout already spent the full budget — terminal for all methods.
    expect(probe.calls()).toBe(1);
  });
});
