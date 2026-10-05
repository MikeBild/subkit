import { describe, expect, test } from "bun:test";
import { classifyFailure, classifyPersistedFailure } from "../classify.ts";

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

describe("a refusal whose reason is a malformed message", () => {
  const refused = (reason: string) => ({
    status: "failed" as const,
    retry_count: 0,
    duration_ms: 0,
    error: {
      code: "execution_authority_changed",
      message: "Report delivery differs from the reviewed sender, recipient or message format",
      reason,
    },
  });

  test("names the message, not the approval", () => {
    expect(classifyFailure(refused("not_utf8"))).toBe("payload_invalid");
    expect(classifyFailure(refused("header_control_byte"))).toBe("payload_invalid");
  });

  test("a message that left the approved recipient is still an approval mismatch", () => {
    expect(classifyFailure(refused("recipient_differs"))).toBe("authority_mismatch");
  });

  test("the persisted step error keeps its reason through classification", () => {
    expect(
      classifyPersistedFailure({
        status: "failed",
        error: {
          code: "execution_authority_changed",
          message: "Report delivery differs from the reviewed sender, recipient or message format",
          reason: "not_utf8",
        },
      }).classification,
    ).toBe("payload_invalid");
  });
});
