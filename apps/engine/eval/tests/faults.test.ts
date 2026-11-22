import { describe, expect, test } from "bun:test";
import { canaryVerdict, classifyRunFault, MAX_ATTEMPTS, withFaultRetry } from "../faults.ts";

describe("classifyRunFault", () => {
  test.each([
    ['POST /v1/conversations → 429: {"code":"rate_limited"}', "rate_limit"],
    ['POST …/messages → 503: {"code":"llm_provider_unavailable"}', "server_error"],
    ["POST …/messages → 502: bad gateway", "server_error"],
    ['POST /v1/conversations → 504: {"code":"llm_timeout"}', "timeout"],
    ['POST …/messages → 400: {"code":"llm_provider_limited"}', "rate_limit"],
    ["The operation timed out.", "timeout"],
    ["TimeoutError: signal timed out", "timeout"],
    ["fetch failed", "network"],
    ["read ECONNRESET", "network"],
    ["provider overloaded", "server_error"],
  ] as const)("%s → %s", (error, fault) => {
    expect(classifyRunFault(error)).toBe(fault);
  });

  test.each([
    [undefined],
    [""],
    ['POST /v1/conversations → 400: {"code":"validation_failed"}'],
    ['POST …/messages → 401: {"code":"unauthorized"}'],
    ['POST …/messages → 402: {"code":"llm_spend_limit_reached"}'],
    ["conversation id missing"],
  ] as const)("%s is a real failure, not a provider fault", (error) => {
    expect(classifyRunFault(error)).toBeNull();
  });
});

describe("withFaultRetry", () => {
  const fake = (errors: Array<string | undefined>) => {
    let n = 0;
    const seen: string[] = [];
    return {
      seen,
      attempt: async () => {
        const error = errors[n];
        n += 1;
        return { value: n, error };
      },
      onFault: async (value: number, fault: string, _error: string, attempt: number) => {
        seen.push(`${value}:${fault}:${attempt}`);
      },
    };
  };

  test("a clean first attempt is scored without retry", async () => {
    const f = fake([undefined]);
    expect(await withFaultRetry(f.attempt, f.onFault)).toEqual({
      kind: "scored",
      value: 1,
      attempts: 1,
    });
    expect(f.seen).toEqual([]);
  });

  test("a provider fault is retried once and the retry is scored", async () => {
    const f = fake(["→ 503: down", undefined]);
    expect(await withFaultRetry(f.attempt, f.onFault)).toEqual({
      kind: "scored",
      value: 2,
      attempts: 2,
    });
    expect(f.seen).toEqual(["1:server_error:1"]);
  });

  test("a model failure is scored, never retried", async () => {
    const f = fake(["→ 400: bad request", undefined]);
    expect(await withFaultRetry(f.attempt, f.onFault)).toEqual({
      kind: "scored",
      value: 1,
      attempts: 1,
    });
  });

  test("two faults leave the case unscored", async () => {
    const f = fake(["→ 429: slow down", "fetch failed", undefined]);
    expect(await withFaultRetry(f.attempt, f.onFault)).toEqual({
      kind: "faulted",
      fault: "network",
      error: "fetch failed",
      attempts: MAX_ATTEMPTS,
    });
    expect(f.seen).toEqual(["1:rate_limit:1", "2:network:2"]);
  });
});

describe("canaryVerdict", () => {
  test("answers → go", () => {
    expect(canaryVerdict({ kind: "scored", value: {}, attempts: 1 })).toEqual({ ok: true });
  });

  test("faulted twice → the provider is down", () => {
    const verdict = canaryVerdict({
      kind: "faulted",
      fault: "server_error",
      error: "→ 503",
      attempts: 2,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.provider_down).toBe(true);
  });

  test("a non-fault error stops the run without blaming the provider", () => {
    expect(
      canaryVerdict({ kind: "scored", value: { error: "→ 401: unauthorized" }, attempts: 1 }),
    ).toEqual({ ok: false, provider_down: false, reason: "canary failed: → 401: unauthorized" });
  });
});
