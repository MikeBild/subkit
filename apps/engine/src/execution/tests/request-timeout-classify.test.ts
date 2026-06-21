// Deterministic unit test for the timeout-is-terminal contract
// (2026-06-21 Gmail send outage): a per-request TIMEOUT must classify as
// `timeout` — NOT `connection` — so it is terminal and never retried
// "regardless of method" (which retried a stalled Gmail POST 5× and risked
// double-sending). `classifyTransportError` is the pure core of that
// decision; testing it directly needs no DB, no socket, no async-context
// plumbing (the reason the earlier behavioural test was flaky).

import { describe, expect, test } from "bun:test";
import { classifyTransportError } from "../steps/request/dispatch.ts";

function timeoutError(): Error {
  // Mirrors Bun's AbortSignal.timeout rejection: DOMException "TimeoutError".
  const e = new Error("The operation timed out.");
  e.name = "TimeoutError";
  return e;
}

describe("classifyTransportError", () => {
  test("a TimeoutError is a timeout (terminal), NOT a retryable connection error", () => {
    expect(classifyTransportError(timeoutError(), false)).toBe("timeout");
  });

  test("an 'operation timed out' message (no name) is a timeout", () => {
    expect(classifyTransportError(new Error("The operation timed out."), false)).toBe("timeout");
  });

  test("a TimeoutError nested under err.cause is a timeout", () => {
    const e = new Error("fetch failed");
    (e as { cause?: unknown }).cause = { name: "TimeoutError" };
    expect(classifyTransportError(e, false)).toBe("timeout");
  });

  test("an AbortError that is NOT the caller's signal is a per-request timeout", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(classifyTransportError(e, false)).toBe("timeout");
  });

  test("the caller's signal aborting is an abort (terminal), regardless of error shape", () => {
    expect(classifyTransportError(timeoutError(), true)).toBe("abort");
    expect(classifyTransportError(new Error("ECONNRESET"), true)).toBe("abort");
  });

  test("a generic transport error is a retryable connection error", () => {
    expect(classifyTransportError(new Error("ECONNRESET"), false)).toBe("connection");
    expect(classifyTransportError(new Error("socket hang up"), false)).toBe("connection");
  });
});
