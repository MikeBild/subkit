// Unit tests for the tool-result truncation policy. The policy must:
//   - pass small values through verbatim,
//   - sample large values and emit a structured marker,
//   - apply different budgets for success and error kinds.

import { describe, expect, test } from "bun:test";

import { truncatedToolResultValue, truncateToolResult } from "../tool-result-truncate.ts";

function bigPayload(approxBytes: number): Record<string, unknown> {
  // Build a simple object with a single string field padded to size.
  const target = approxBytes - 64; // headroom for keys
  const blob = "x".repeat(Math.max(0, target));
  return { kind: "doc", content: blob };
}

describe("truncateToolResult", () => {
  test("small success value passes through verbatim", () => {
    const small = { kind: "row", id: 1, name: "alice" };
    const result = truncateToolResult(small, "success");
    expect(result.value).toEqual(small);
    expect(result.truncated).toBeNull();
  });

  test("oversized success value gets sampled with marker", () => {
    const large = bigPayload(120_000);
    const result = truncateToolResult(large, "success");
    expect(result.truncated).not.toBeNull();
    expect(result.truncated?.reason).toBe("exceeded_success_bytes");
    expect(result.truncated?.original_bytes).toBeGreaterThan(80_000);
  });

  test("oversized error value gets sampled with the error reason", () => {
    const large = bigPayload(80_000);
    const result = truncateToolResult(large, "error");
    expect(result.truncated).not.toBeNull();
    expect(result.truncated?.reason).toBe("exceeded_error_bytes");
  });

  test("error budget bites earlier than success budget", () => {
    const between = bigPayload(60_000); // > 50KB error budget but < 80KB success budget
    const errResult = truncateToolResult(between, "error");
    const okResult = truncateToolResult(between, "success");
    expect(errResult.truncated).not.toBeNull();
    expect(okResult.truncated).toBeNull();
  });

  test("custom budget overrides the default", () => {
    const tinyBudget = { kind: "row", id: 1 };
    const result = truncateToolResult(tinyBudget, "success", { success_bytes: 1 });
    expect(result.truncated).not.toBeNull();
  });

  test("truncatedToolResultValue embeds _truncated as a sibling on objects", () => {
    const large = bigPayload(120_000);
    const out = truncatedToolResultValue(large, "success") as Record<string, unknown>;
    expect(out._truncated).toBeDefined();
    expect((out._truncated as Record<string, unknown>).reason).toBe("exceeded_success_bytes");
  });

  test("truncatedToolResultValue wraps non-object values when truncating", () => {
    const longString = "y".repeat(100_000);
    const out = truncatedToolResultValue(longString, "success") as Record<string, unknown>;
    // Strings JSON-encode with quotes, so the byte count exceeds 80 KB.
    expect(out._truncated).toBeDefined();
    expect(out.value).toBe(longString);
  });

  test("does not throw on cyclic input (uses string fallback)", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => truncateToolResult(a, "success")).not.toThrow();
  });
});
