import { describe, expect, test } from "bun:test";
import { classifyFailure, isTransientRunResult, PREVIEW_CLASSIFICATIONS } from "./classify.ts";
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

describe("classifyFailure — incomplete reads and rate limits by code", () => {
  const failed = (code: string, message: string) =>
    classifyFailure({ status: "failed", retry_count: 0, duration_ms: 0, error: { code, message } });

  test("pagination codes are incomplete reads, not driver errors or timeouts", () => {
    for (const code of [
      "pagination_limit_reached",
      "pagination_link_foreign",
      "pagination_link_unsupported",
      "pagination_link_loop",
      "pagination_short_page",
      "graphql_pagination_incomplete",
    ])
      expect(failed(code, "pagination reached max_items exceeded before the end")).toBe(
        "incomplete_read",
      );
  });

  test("rate-limit codes are rate limits even when the message mentions 403 or exceeded", () => {
    expect(failed("upstream_rate_limited", "http 403: API rate limit exceeded")).toBe(
      "rate_limited",
    );
    expect(failed("http_429", "http 429")).toBe("rate_limited");
  });

  test("an unknown code with a rate-limit message is never a timeout or an auth failure", () => {
    const verdict = failed("http_4xx", "API rate limit exceeded for user ID 1");
    expect(verdict).not.toBe("timeout");
    expect(verdict).not.toBe("auth_failed");
    expect(verdict).toBe("rate_limited");
  });

  test("ordinary timeouts and auth failures keep their classes", () => {
    expect(failed("http_4xx", "http 401 unauthorized")).toBe("auth_failed");
    expect(failed("connection", "operation timed out")).toBe("timeout");
  });

  test("the new classes are part of the published vocabulary", () => {
    expect(PREVIEW_CLASSIFICATIONS).toContain("incomplete_read");
    expect(PREVIEW_CLASSIFICATIONS).toContain("rate_limited");
  });
});
