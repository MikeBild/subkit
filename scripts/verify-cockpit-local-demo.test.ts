import { describe, expect, test } from "bun:test";
import {
  assertLocalChatResponseModel,
  cleanupLocalWorkflow,
  finalizeLocalVerification,
  localChatVerificationMode,
  redactLocalVerificationError,
} from "./lib/cockpit-demo-verification.ts";

describe("local demo chat verification mode", () => {
  test("requires a real provider unless mock verification is explicitly requested", () => {
    expect(localChatVerificationMode(false)).toBe("provider");
    expect(localChatVerificationMode(true)).toBe("mock");
  });

  test("rejects missing or mock model provenance for a real provider response", () => {
    for (const model of [undefined, null, "", "  ", "mock", "mock:configured-model", "Mock/model"])
      expect(() => assertLocalChatResponseModel(model, false)).toThrow();
    expect(() => assertLocalChatResponseModel("configured-provider-model", false)).not.toThrow();
  });

  test("offline verification requires a response identified as mocked", () => {
    expect(() => assertLocalChatResponseModel("mock:configured-model", true)).not.toThrow();
    expect(() => assertLocalChatResponseModel("configured-provider-model", true)).toThrow();
  });

  test("removes the owned workflow even when authority revocation fails", async () => {
    const actions: string[] = [];
    const failures = await cleanupLocalWorkflow({
      revoke: async () => {
        actions.push("revoke");
        throw new Error("revocation unavailable");
      },
      remove: async () => {
        actions.push("remove");
      },
    });
    expect(actions).toEqual(["revoke", "remove"]);
    expect(failures).toEqual(["revocation unavailable"]);
  });

  test("cleans an early failed journey before an authority exists and reports deletion errors", async () => {
    const failures = await cleanupLocalWorkflow({
      remove: async () => {
        throw new Error("deletion unavailable");
      },
    });
    expect(failures).toEqual(["deletion unavailable"]);
  });

  test("redacts authentication values in browser call logs without forwarding the original error", () => {
    const original = new Error("fill(key-secret), cookie=session-secret, csrf=csrf-secret");
    original.stack = "raw browser stack key-secret";
    const sanitized = new Error(
      redactLocalVerificationError(original, ["key-secret", "session-secret", "csrf-secret", ""]),
    );
    expect(sanitized.message).toBe("fill([redacted]), cookie=[redacted], csrf=[redacted]");
    expect(sanitized.stack).not.toContain("key-secret");
    expect(sanitized).not.toHaveProperty("cause");
    expect(redactLocalVerificationError("session-secret failed", ["session-secret"])).toBe(
      "[redacted] failed",
    );
  });

  test("closes context and browser independently when receipt storage and context closing fail", async () => {
    const actions: string[] = [];
    const failures = await finalizeLocalVerification({
      saveReceipt: async () => {
        actions.push("receipt");
        throw new Error("disk unavailable");
      },
      closeContext: async () => {
        actions.push("context");
        throw new Error("context unavailable");
      },
      closeBrowser: async () => {
        actions.push("browser");
      },
    });
    expect(actions).toEqual(["context", "browser", "receipt"]);
    expect(failures).toEqual([
      "Browser context cleanup: context unavailable",
      "Receipt: disk unavailable",
    ]);
  });
  test("writes a failed receipt after collecting all browser cleanup errors", async () => {
    let saved: { passed: boolean; cleanupErrors: string[] } | null = null;
    const failures = await finalizeLocalVerification({
      closeContext: async () => {
        throw new Error("context unavailable");
      },
      closeBrowser: async () => {
        throw new Error("browser unavailable");
      },
      saveReceipt: async (cleanupFailures) => {
        saved = { passed: cleanupFailures.length === 0, cleanupErrors: [...cleanupFailures] };
      },
    });
    expect(saved).toEqual({
      passed: false,
      cleanupErrors: [
        "Browser context cleanup: context unavailable",
        "Browser cleanup: browser unavailable",
      ],
    });
    expect(failures).toEqual([
      "Browser context cleanup: context unavailable",
      "Browser cleanup: browser unavailable",
    ]);
  });
});
