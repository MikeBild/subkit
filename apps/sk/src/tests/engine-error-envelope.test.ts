import { EngineError } from "@cli-core/errors.ts";
import { describe, expect, test } from "bun:test";

describe("EngineError parses the engine error envelope", () => {
  test("plain envelope leaves hint/retry_after null", () => {
    const e = new EngineError(404, { code: "not_found", message: "missing" });
    expect(e.code).toBe("not_found");
    expect(e.message).toBe("missing");
    expect(e.hint).toBeNull();
    expect(e.retry_after).toBeNull();
    expect(e.trace_id).toBeNull();
  });

  test("hint string is captured verbatim", () => {
    const e = new EngineError(409, {
      code: "conflict",
      message: "stale write",
      hint: "refetch the resource",
    });
    expect(e.hint).toBe("refetch the resource");
  });

  test("retry_after numeric value is preserved (rounded up)", () => {
    const e = new EngineError(429, {
      code: "llm_provider_limited",
      message: "rate limited",
      retry_after: 12,
    });
    expect(e.retry_after).toBe(12);
  });

  test("retry_after fractional is ceiled", () => {
    const e = new EngineError(429, {
      code: "rate_limited",
      message: "slow",
      retry_after: 4.2,
    });
    expect(e.retry_after).toBe(5);
  });

  test("retry_after negative is clamped to 0", () => {
    const e = new EngineError(429, {
      code: "rate_limited",
      message: "slow",
      retry_after: -3,
    });
    expect(e.retry_after).toBe(0);
  });

  test("non-numeric retry_after is ignored", () => {
    const e = new EngineError(429, {
      code: "rate_limited",
      message: "slow",
      retry_after: "soon" as unknown as number,
    });
    expect(e.retry_after).toBeNull();
  });

  test("trace_id and details flow through", () => {
    const e = new EngineError(500, {
      code: "internal_error",
      message: "boom",
      trace_id: "abc-123",
      details: { where: "x" },
    });
    expect(e.trace_id).toBe("abc-123");
    expect(e.details).toEqual({ where: "x" });
  });

  test("missing/empty hint resolves to null (not empty string)", () => {
    const e = new EngineError(400, { code: "bad_request", message: "x", hint: "" });
    expect(e.hint).toBeNull();
  });
});
