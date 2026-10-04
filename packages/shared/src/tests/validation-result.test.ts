import { describe, expect, test } from "bun:test";
import { ConnectorOperationError, fail, isConnectorOperationError, ok } from "../index.ts";

describe("ValidationResult helpers", () => {
  test("ok wraps a payload", () => {
    const r = ok({ id: "x" });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.payload).toEqual({ id: "x" });
  });

  test("fail wraps an errors array", () => {
    const r = fail([{ code: "E1", message: "boom" }]);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors).toHaveLength(1);
  });
});

describe("ConnectorOperationError", () => {
  test("carries code + metadata", () => {
    const e = new ConnectorOperationError("FTP_AUTH_FAILED", "bad creds", {
      host: "ftp.example.com",
    });
    expect(e.code).toBe("FTP_AUTH_FAILED");
    expect(e.metadata).toEqual({ host: "ftp.example.com" });
    expect(e.message).toBe("bad creds");
    expect(e.name).toBe("ConnectorOperationError");
  });

  test("isConnectorOperationError narrows correctly", () => {
    const e: unknown = new ConnectorOperationError("X", "msg");
    expect(isConnectorOperationError(e)).toBe(true);
    expect(isConnectorOperationError(new Error("plain"))).toBe(false);
    expect(isConnectorOperationError(null)).toBe(false);
  });
});
