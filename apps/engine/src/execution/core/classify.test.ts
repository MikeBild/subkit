import { expect, test } from "bun:test";
import fc from "fast-check";
import type { StepDef } from "../../workflows/types.ts";
import type { RunResult, StepResult } from "../types.ts";
import {
  classifyFailure,
  classifyPersistedFailure,
  classifyRunFailure,
  classifyRunResult,
  humanizeClassification,
  isTransientRunResult,
  PREVIEW_CLASSIFICATIONS,
} from "./classify.ts";

const failed = (
  code: string,
  message = "unexpected",
  status: StepResult["status"] = "failed",
): StepResult => ({ status, retry_count: 0, duration_ms: 5, error: { code, message } });
const step: StepDef = { id: "fetch", kind: "transform", expression: "42" };
const run = (status: RunResult["status"], error: RunResult["error"] = null): RunResult => ({
  execution_id: "run",
  status,
  output: null,
  error,
  steps: [],
});

test("preview classifications retain every public result category", () => {
  expect(PREVIEW_CLASSIFICATIONS).toEqual([
    "ok",
    "auth_failed",
    "placeholder_unresolved",
    "schema_mismatch",
    "timeout",
    "aborted",
    "connector_missing",
    "budget_exhausted",
    "connector_unavailable",
    "refused_before_start",
    "authority_mismatch",
    "payload_invalid",
    "driver_error",
    "preview_unsupported",
    "unknown",
    "incomplete_read",
    "rate_limited",
  ]);
});

test("terminal statuses override codes, codes override message heuristics", () => {
  for (const [status, expected] of [
    ["aborted", "aborted"],
    ["skipped", "aborted"],
    ["timed_out", "timeout"],
  ] as const)
    expect(classifyFailure(failed("connector_not_found", "401", status))).toBe(expected);
  for (const [code, expected] of [
    ["connector_not_found", "connector_missing"],
    ["prepared_credential_unavailable", "connector_unavailable"],
    ["connector_disabled", "connector_unavailable"],
    ["orphaned_preparation", "refused_before_start"],
    ["execution_authority_missing", "authority_mismatch"],
    ["llm_spend_limit_reached", "budget_exhausted"],
    ["llm_budget_exceeded", "budget_exhausted"],
    ["missing_graphql", "driver_error"],
    ["unknown_step_kind", "driver_error"],
    ["data_selector_error", "schema_mismatch"],
    ["pagination_limit", "incomplete_read"],
    ["graphql_pagination_incomplete", "incomplete_read"],
    ["upstream_rate_limited", "rate_limited"],
    ["http_429", "rate_limited"],
    ["graphql_throttle", "rate_limited"],
  ] as const)
    expect(classifyFailure(failed(code, "401 unauthorized timeout"))).toBe(expected);
  expect(
    classifyPersistedFailure({
      status: "failed",
      error: { code: "execution_authority_changed", reason: "not_json_raw" },
    }).classification,
  ).toBe("payload_invalid");
  expect(
    classifyPersistedFailure({
      status: "failed",
      error: { code: "execution_authority_changed", reason: "recipient_differs" },
    }).classification,
  ).toBe("authority_mismatch");
});

test("message heuristics retain precedence and unknown failures remain driver errors", () => {
  for (const [message, expected] of [
    ["RATE LIMIT exceeded 403", "rate_limited"],
    ["placeholder unresolved auth timeout", "placeholder_unresolved"],
    ["Unauthorized timeout", "auth_failed"],
    ["operation timed out", "timeout"],
    ["abort requested", "aborted"],
    ["other", "driver_error"],
  ] as const)
    expect(classifyFailure(failed("other", message))).toBe(expected);
  expect(classifyFailure(failed("placeholder_unresolved", "other"))).toBe("placeholder_unresolved");
  expect(classifyFailure({ status: "failed", retry_count: 0, duration_ms: 0, error: null })).toBe(
    "driver_error",
  );
});

test("persisted errors normalize untrusted payloads and preserve valid guidance", () => {
  for (const error of [null, undefined, 12, "oops", {}, { code: 12, message: false, guidance: [] }])
    expect(classifyPersistedFailure({ status: "failed", error })).toEqual({
      classification: "driver_error",
      error_code: null,
      message: "",
      guidance: null,
    });
  expect(
    classifyPersistedFailure({
      status: "timed_out",
      error: { code: "x", message: "late", guidance: "retry" },
    }),
  ).toEqual({ classification: "timeout", error_code: "x", message: "late", guidance: "retry" });
  for (const status of ["aborted", "skipped"])
    expect(classifyPersistedFailure({ status, error: null }).classification).toBe("aborted");
  expect(classifyRunFailure({ status: "failed", failure: null }, null)).toBeNull();
  expect(
    classifyRunFailure(
      { status: "failed", failure: { error_code: "connector_not_found", error_message: "gone" } },
      null,
    )?.classification,
  ).toBe("connector_missing");
  expect(
    classifyRunFailure(
      { status: "failed", failure: { error_code: "connector_not_found" } },
      { status: "timed_out", error: null },
    )?.classification,
  ).toBe("timeout");
});

test("run projection preserves success output and failed summaries with optional errors", () => {
  expect(classifyRunResult(step, { ...run("succeeded"), output: { count: 2 } })).toEqual({
    ok: true,
    step_id: "fetch",
    kind: "transform",
    duration_ms: 0,
    classification: "ok",
    summary: "Ran step `fetch` (transform) in 0ms.",
    output_preview: { count: 2 },
  });
  expect(classifyRunResult(step, run("failed"))).toEqual({
    ok: false,
    step_id: "fetch",
    kind: "transform",
    duration_ms: 0,
    classification: "driver_error",
    summary: "The step driver failed: step failed",
  });
  for (const [status, classification] of [
    ["timed_out", "timeout"],
    ["aborted", "aborted"],
  ] as const)
    expect(classifyRunResult(step, run(status)).classification).toBe(classification);
  expect(
    classifyRunResult(step, run("failed", { code: "connector_not_found", message: "gone" })).error,
  ).toEqual({ code: "connector_not_found", message: "gone" });
});

test("run summaries use the last persisted step duration", () => {
  const steps: RunResult["steps"] = [
    {
      step_key: "first",
      step_index: 0,
      kind: "transform",
      status: "succeeded",
      duration_ms: 12,
      retry_count: 0,
      error: null,
    },
    {
      step_key: "last",
      step_index: 1,
      kind: "transform",
      status: "failed",
      duration_ms: 37,
      retry_count: 2,
      error: null,
    },
  ];
  expect(classifyRunResult(step, { ...run("succeeded"), steps }).duration_ms).toBe(37);
  expect(classifyRunResult(step, { ...run("failed"), steps }).duration_ms).toBe(37);
});

test("a failed run keeps the class it recorded instead of re-deriving it from the code", () => {
  const error = { code: "connector_not_found", message: "gone", error_class: "rate_limited" };
  for (const status of ["failed", "succeeded", "running", "cancelled", ""])
    expect(classifyPersistedFailure({ status, error })).toEqual({
      classification: "rate_limited",
      error_code: "connector_not_found",
      message: "gone",
      guidance: null,
    });
  expect(
    classifyPersistedFailure({ status: "failed", error: { error_class: "authority_mismatch" } }),
  ).toEqual({
    classification: "authority_mismatch",
    error_code: null,
    message: "",
    guidance: null,
  });
});

test("a recorded class never overrides a stopped run or an unknown class", () => {
  const recorded = { code: "connector_not_found", message: "gone", error_class: "rate_limited" };
  for (const [status, expected] of [
    ["timed_out", "timeout"],
    ["aborted", "aborted"],
    ["skipped", "aborted"],
  ] as const)
    expect(classifyPersistedFailure({ status, error: recorded }).classification).toBe(expected);
  for (const error_class of [
    "ok",
    "bogus",
    "",
    "RATE_LIMITED",
    12,
    null,
    undefined,
    ["rate_limited"],
  ])
    expect(
      classifyPersistedFailure({
        status: "failed",
        error: { code: "connector_not_found", message: "gone", error_class },
      }).classification,
    ).toBe("connector_missing");
});

test("persisted errors reject callable records and ignore metadata without an error code", () => {
  const callable = Object.assign(() => undefined, {
    code: "connector_not_found",
    message: "gone",
    guidance: "reconnect",
  });
  expect(classifyPersistedFailure({ status: "failed", error: callable })).toEqual({
    classification: "driver_error",
    error_code: null,
    message: "",
    guidance: null,
  });
  expect(
    classifyPersistedFailure({
      status: "failed",
      error: { message: "403 forbidden", reason: "not_json_raw" },
    }),
  ).toEqual({
    classification: "driver_error",
    error_code: null,
    message: "403 forbidden",
    guidance: null,
  });
  expect(
    classifyPersistedFailure({
      status: "failed",
      error: { code: "execution_authority_changed", reason: 1 },
    }).classification,
  ).toBe("authority_mismatch");
});

test("human summaries provide actionable class-specific descriptions", () => {
  const cases = {
    auth_failed: "Authentication was rejected",
    placeholder_unresolved: "A placeholder could not be resolved from scope: detail",
    schema_mismatch: "data_selector did not match",
    timeout: "exceeded its timeout",
    aborted: "was cancelled",
    budget_exhausted: "token allowance is used up",
    connector_missing: "is not available",
    connector_unavailable: "cannot serve it: detail",
    refused_before_start: "never ran",
    authority_mismatch: "approval no longer matches",
    payload_invalid: "malformed and was not sent",
    preview_unsupported: "cannot be run in isolation",
    driver_error: "The step driver failed: detail",
    incomplete_read: "before every page was read",
    rate_limited: "rate limit stopped",
  } as const;
  for (const [classification, text] of Object.entries(cases))
    expect(
      humanizeClassification(classification as keyof typeof cases, "detail", "request"),
    ).toContain(text);
  expect(humanizeClassification("unknown", "detail", "request")).toBe("detail");
  expect(humanizeClassification("ok", "", "request")).toBe("Step failed.");
});

test("only known transient codes retry and timeouts never retry", () => {
  for (const code of ["connection", "http_5xx", "http_429", "graphql_throttle", "graphql_5xx"]) {
    expect(isTransientRunResult(run("failed", { code, message: "error" }))).toBe(true);
    expect(isTransientRunResult(run("timed_out", { code, message: "error" }))).toBe(false);
  }
  expect(isTransientRunResult(run("failed"))).toBe(false);
  expect(isTransientRunResult(run("failed", { code: "other", message: "error" }))).toBe(false);
});

test("classifying frozen failure data is deterministic and preserves its input", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (code, message) => {
      const failure = Object.freeze({ status: "failed", error: Object.freeze({ code, message }) });
      const before = JSON.stringify(failure);
      expect(classifyPersistedFailure(failure)).toEqual(classifyPersistedFailure(failure));
      expect(JSON.stringify(failure)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
