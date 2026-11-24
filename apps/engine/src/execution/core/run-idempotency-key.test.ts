import { describe, expect, test } from "bun:test";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  isRunIdempotencyKey,
  runIdempotencyKeyLength,
} from "./run-idempotency-key.ts";

describe("run idempotency key", () => {
  test("measures length in Unicode code points", () => {
    expect(runIdempotencyKeyLength("🚚")).toBe(1);
    expect(runIdempotencyKeyLength("é")).toBe(1);
    expect(runIdempotencyKeyLength(`${"k".repeat(199)}🚚`)).toBe(IDEMPOTENCY_KEY_MAX_LENGTH);
  });

  test("accepts 1 to 200 code points only", () => {
    expect(isRunIdempotencyKey(`${"k".repeat(199)}🚚`)).toBe(true);
    expect(isRunIdempotencyKey("k")).toBe(true);
    expect(isRunIdempotencyKey(`${"k".repeat(200)}🚚`)).toBe(false);
    expect(isRunIdempotencyKey("")).toBe(false);
  });
});
