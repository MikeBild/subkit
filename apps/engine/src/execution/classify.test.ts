// Unit truth-table for isTransientRunResult.
// Pure function — no database, no network.
//
// Codifies the contract from classify.ts:
//   - transient transport/rate-limit codes → retryable
//   - timeout is explicitly EXCLUDED (terminal outcome)
//   - deterministic failures (auth, 4xx, schema) → not retryable

import { describe, expect, test } from "bun:test";
import { isTransientRunResult } from "./classify.ts";
import type { RunResult } from "./types.ts";

function failedRun(code: string, status: "failed" | "timed_out" = "failed"): RunResult {
  return {
    execution_id: "test",
    status,
    output: null,
    error: { code, message: `test error ${code}` },
    steps: [],
  };
}

function succeededRun(): RunResult {
  return {
    execution_id: "test",
    status: "succeeded",
    output: { ok: true },
    error: null,
    steps: [],
  };
}

describe("isTransientRunResult — transient codes (retryable)", () => {
  test("http_5xx → transient", () => {
    expect(isTransientRunResult(failedRun("http_5xx"))).toBe(true);
  });

  test("http_429 → transient", () => {
    expect(isTransientRunResult(failedRun("http_429"))).toBe(true);
  });

  test("connection → transient", () => {
    expect(isTransientRunResult(failedRun("connection"))).toBe(true);
  });

  test("graphql_throttle → transient", () => {
    expect(isTransientRunResult(failedRun("graphql_throttle"))).toBe(true);
  });

  test("graphql_5xx → transient", () => {
    expect(isTransientRunResult(failedRun("graphql_5xx"))).toBe(true);
  });
});

describe("isTransientRunResult — timeout is NOT retryable", () => {
  test("timed_out status → not transient (re-running re-spends the budget)", () => {
    expect(isTransientRunResult(failedRun("step_timeout", "timed_out"))).toBe(false);
  });

  test("failed status with step_timeout code → not transient", () => {
    // A run that records the timeout code but surfaces failed status
    // must still not retry — the budget is gone.
    expect(isTransientRunResult(failedRun("step_timeout"))).toBe(false);
  });
});

describe("isTransientRunResult — deterministic failures (not retryable)", () => {
  test("succeeded → not transient", () => {
    expect(isTransientRunResult(succeededRun())).toBe(false);
  });

  test("http_4xx (auth/forbidden) → not transient", () => {
    expect(isTransientRunResult(failedRun("http_4xx"))).toBe(false);
  });

  test("connector_not_found → not transient", () => {
    expect(isTransientRunResult(failedRun("connector_not_found"))).toBe(false);
  });

  test("graphql_error (business error) → not transient", () => {
    expect(isTransientRunResult(failedRun("graphql_error"))).toBe(false);
  });

  test("placeholder_unresolved → not transient", () => {
    expect(isTransientRunResult(failedRun("placeholder_unresolved"))).toBe(false);
  });

  test("run with null error → not transient", () => {
    const run: RunResult = {
      execution_id: "test",
      status: "failed",
      output: null,
      error: null,
      steps: [],
    };
    expect(isTransientRunResult(run)).toBe(false);
  });

  test("aborted run → not transient", () => {
    const run: RunResult = {
      execution_id: "test",
      status: "aborted",
      output: null,
      error: { code: "abort", message: "aborted" },
      steps: [],
    };
    expect(isTransientRunResult(run)).toBe(false);
  });
});
