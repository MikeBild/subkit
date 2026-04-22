// Unit tests for classifyFailure — pure function, no DB.

import { describe, expect, test } from "bun:test";
import { classifyFailure, isPermanentFailure } from "../failure-classifier.ts";

describe("classifyFailure", () => {
  test("429 → rate_limited", () => {
    expect(classifyFailure({ status: 429, error: "http_429" })).toBe("rate_limited");
  });

  test("401 / 403 → auth_failure", () => {
    expect(classifyFailure({ status: 401, error: "http_401" })).toBe("auth_failure");
    expect(classifyFailure({ status: 403, error: "http_403" })).toBe("auth_failure");
  });

  test("500..599 → transient_5xx", () => {
    expect(classifyFailure({ status: 500, error: "http_500" })).toBe("transient_5xx");
    expect(classifyFailure({ status: 503, error: "http_503" })).toBe("transient_5xx");
    expect(classifyFailure({ status: 599, error: "http_599" })).toBe("transient_5xx");
  });

  test("400..499 (non-429, non-401, non-403) → permanent_4xx", () => {
    expect(classifyFailure({ status: 400, error: "http_400" })).toBe("permanent_4xx");
    expect(classifyFailure({ status: 404, error: "http_404" })).toBe("permanent_4xx");
    expect(classifyFailure({ status: 410, error: "http_410" })).toBe("permanent_4xx");
  });

  test("status 0 with error message → transient_network", () => {
    expect(classifyFailure({ status: 0, error: "ECONNRESET" })).toBe("transient_network");
    expect(classifyFailure({ status: 0, error: "fetch failed" })).toBe("transient_network");
  });

  test("status 0 with no error → unknown", () => {
    expect(classifyFailure({ status: 0, error: null })).toBe("unknown");
  });
});

describe("isPermanentFailure", () => {
  test("permanent_4xx and auth_failure short-circuit the retry ladder", () => {
    expect(isPermanentFailure("permanent_4xx")).toBe(true);
    expect(isPermanentFailure("auth_failure")).toBe(true);
  });

  test("transient categories do not short-circuit", () => {
    expect(isPermanentFailure("transient_5xx")).toBe(false);
    expect(isPermanentFailure("transient_network")).toBe(false);
    expect(isPermanentFailure("rate_limited")).toBe(false);
    expect(isPermanentFailure("unknown")).toBe(false);
  });
});
