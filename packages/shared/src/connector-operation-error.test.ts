import { describe, expect, test } from "bun:test";
import { ConnectorOperationError, isConnectorOperationError } from "./connector-operation-error.ts";

describe("connector operation failure contract", () => {
  test("preserves the machine code, diagnostic message and provider metadata", () => {
    const metadata = { operation: "read", retry_after: 20 };
    const failure = new ConnectorOperationError("provider_busy", "Try again later", metadata);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe("ConnectorOperationError");
    expect(failure.code).toBe("provider_busy");
    expect(failure.message).toBe("Try again later");
    expect(failure.metadata).toBe(metadata);
  });

  test("failures without provider metadata have independent empty details", () => {
    const first = new ConnectorOperationError("unavailable", "First");
    const second = new ConnectorOperationError("unavailable", "Second");
    expect(first.metadata).toEqual({});
    expect(second.metadata).toEqual({});
    expect(first.metadata).not.toBe(second.metadata);
    first.metadata.operation = "write";
    expect(second.metadata).toEqual({});
  });

  test("recognizes actual connector errors and derived provider errors", () => {
    class ProviderError extends ConnectorOperationError {}
    expect(isConnectorOperationError(new ConnectorOperationError("denied", "Denied"))).toBe(true);
    expect(isConnectorOperationError(new ProviderError("denied", "Denied"))).toBe(true);
  });

  test("does not classify unrelated errors or untrusted lookalike payloads as connector errors", () => {
    for (const value of [
      undefined,
      null,
      false,
      "failure",
      1,
      new Error("Denied"),
      { name: "ConnectorOperationError", code: "denied", message: "Denied", metadata: {} },
    ]) {
      expect(isConnectorOperationError(value)).toBe(false);
    }
  });
});
