import { describe, expect, test } from "bun:test";
import { classifyFailure } from "../classify.ts";

const step = (code: string, message: string) => ({
  status: "failed" as const,
  retry_count: 0,
  duration_ms: 0,
  error: { code, message },
});

describe("an execution authority refusal", () => {
  test("is its own class, not a rejected sign-in", () => {
    expect(
      classifyFailure(
        step(
          "execution_authority_changed",
          "Execution authority could not be verified: execution_authority_changed; review the current boundary.",
        ),
      ),
    ).toBe("authority_mismatch");
  });

  test("a message that merely contains 'authority' is not read as auth", () => {
    expect(classifyFailure(step("http_4xx", "upstream authority record is stale"))).toBe(
      "driver_error",
    );
  });

  test("a real rejected sign-in still reads as one", () => {
    expect(classifyFailure(step("http_4xx", "401 Unauthorized"))).toBe("auth_failed");
    expect(classifyFailure(step("driver_error", "authentication failed"))).toBe("auth_failed");
  });
});
