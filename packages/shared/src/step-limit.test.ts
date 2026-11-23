import { describe, expect, test } from "bun:test";
import { formatLimitDuration, stepLimitOf } from "./step-limit.ts";

describe("stepLimitOf", () => {
  test("reads the time limit of a request step from its failure", () => {
    expect(stepLimitOf({ code: "step_timeout", message: "request exceeded 30000ms" })).toEqual({
      kind: "time",
      ms: 30_000,
      ceiling: false,
    });
  });

  test("reads a transform limit and tells when the operator ceiling clamped it", () => {
    expect(
      stepLimitOf({ code: "transform_timeout", message: "transform exceeded 60000ms" }),
    ).toEqual({ kind: "time", ms: 60_000, ceiling: false });
    expect(
      stepLimitOf({
        code: "transform_timeout",
        message:
          "transform exceeded 300000ms (operator ceiling sandbox.max_transform_wall_ms; timeout_ms 900000 was clamped)",
      }),
    ).toEqual({ kind: "time", ms: 300_000, ceiling: true });
  });

  test("prefers a structured limit_ms on the failure", () => {
    expect(
      stepLimitOf({ code: "step_timeout", message: "request exceeded 1ms", limit_ms: 45_000 }),
    ).toEqual({ kind: "time", ms: 45_000, ceiling: false });
  });

  test("reads the paging limits that stopped a step", () => {
    const paging = (message: string) => stepLimitOf({ code: "pagination_limit_reached", message });
    expect(paging("pagination reached max_pages=20 before the endpoint terminated")).toEqual({
      kind: "pages",
      count: 20,
    });
    expect(paging("pagination reached max_items=500 before the endpoint terminated")).toEqual({
      kind: "items",
      count: 500,
    });
    expect(
      paging("pagination exceeded the 64MB in-memory byte cap before the endpoint terminated"),
    ).toEqual({ kind: "memory", bytes: 64 * 1024 * 1024 });
  });

  test("reads the response size limit", () => {
    expect(
      stepLimitOf({
        code: "request_invalid",
        message: "response too large: exceeds max_response_bytes 10485760",
      }),
    ).toEqual({ kind: "response", bytes: 10_485_760 });
  });

  test("names no limit when the failure carries no value", () => {
    expect(stepLimitOf(null)).toBeNull();
    expect(stepLimitOf({ code: "step_timeout" })).toBeNull();
    expect(stepLimitOf({ code: "step_timeout", message: "operation timed out" })).toBeNull();
    expect(stepLimitOf({ code: "timed_out", message: "request exceeded 30000ms" })).toBeNull();
    expect(stepLimitOf({ code: "step_timeout", message: "request exceeded 0ms" })).toBeNull();
    expect(stepLimitOf({ code: "pagination_limit_reached", message: "stopped" })).toBeNull();
  });
});

describe("formatLimitDuration", () => {
  test("picks the largest fitting unit", () => {
    expect(formatLimitDuration(500, "en-US")).toBe("500 ms");
    expect(formatLimitDuration(30_000, "en-US")).toBe("30 s");
    expect(formatLimitDuration(90_000, "en-US")).toBe("1.5 min");
    expect(formatLimitDuration(3_600_000, "en-US")).toBe("1 h");
  });

  test("uses the locale’s decimal separator", () => {
    expect(formatLimitDuration(1_500, "de-DE")).toBe("1,5 s");
  });
});
