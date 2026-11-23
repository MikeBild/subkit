import { describe, expect, test } from "bun:test";
import { classifyPersistedFailure } from "../core/classify.ts";
import { sensitiveFailure } from "../sensitive-payload.ts";

describe("sensitive failures keep a class a person can act on", () => {
  test("a rejected sign-in keeps its class and names the remedy without the vendor's words", () => {
    const failure = sensitiveFailure(
      "http_401",
      "401 Unauthorized: token abc123 for jane@example.com",
    );
    expect(failure.code).toBe("sensitive_execution_failure");
    expect(failure.error_class).toBe("auth_failed");
    expect(failure.message).toContain("Reconnect the connector");
    expect(failure.message).not.toContain("abc123");
    expect(failure.message).not.toContain("jane@example.com");
  });

  test("an authority code stays readable and classifies as an approval that no longer fits", () => {
    const failure = sensitiveFailure("execution_authority_unavailable", "no live authority");
    expect(failure.code).toBe("execution_authority_unavailable");
    expect(classifyPersistedFailure({ status: "failed", error: failure }).classification).toBe(
      "authority_mismatch",
    );
  });

  test("a step skipped by control flow stays skipped and never reads as a failure", () => {
    const failure = sensitiveFailure("skipped", "branch not taken for customer jane@example.com");
    expect(failure.code).toBe("skipped");
    expect(failure.message).toContain("skipped");
    expect(failure.message).not.toContain("jane@example.com");
  });

  test("a disabled connector keeps its code", () => {
    expect(sensitiveFailure("connector_disabled", "Connector x is disabled").code).toBe(
      "connector_disabled",
    );
  });

  test("an unknown failure stays fully protected", () => {
    const failure = sensitiveFailure("driver_exploded", "secret payload leaked here");
    expect(failure.code).toBe("sensitive_execution_failure");
    expect(failure.error_class).toBeUndefined();
    expect(failure.message).toBe("Sensitive execution failed.");
    expect(failure.message).not.toContain("secret payload");
  });

  test("the stored class wins over the protected code when the failure is read back", () => {
    const stored = sensitiveFailure("http_403", "403 Forbidden");
    const read = classifyPersistedFailure({
      status: "failed",
      error: { code: stored.code, message: stored.message, error_class: stored.error_class },
    });
    expect(read.classification).toBe("auth_failed");
    expect(read.error_code).toBe("sensitive_execution_failure");
  });

  test("a class from outside the vocabulary is ignored", () => {
    const read = classifyPersistedFailure({
      status: "failed",
      error: { code: "sensitive_execution_failure", message: "x", error_class: "made_up" },
    });
    expect(read.classification).toBe("driver_error");
  });

  test("no code at all yields the protected default", () => {
    expect(sensitiveFailure().code).toBe("sensitive_execution_failure");
  });
});
