import { describe, expect, test } from "bun:test";
import { RUNNER_ASSERTION_AUDIENCE } from "@shared/device/runner-wire.ts";
import {
  checkRunnerAssertion,
  nonceExpiresAt,
  RUNNER_ASSERTION_SKEW_MS,
  RUNNER_TOKEN_PREFIX,
  RUNNER_TOKEN_TTL_MS,
} from "./assertion.ts";

const RUNNER = "66666666-6666-4666-8666-666666666666";
const NOW = Date.parse("2026-11-21T10:00:00.000Z");
const NONCE = "AAECAwQFBgcICQoLDA0ODw";

function text(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    aud: RUNNER_ASSERTION_AUDIENCE,
    device_runner_id: RUNNER,
    iat: new Date(NOW).toISOString(),
    nonce: NONCE,
    ...overrides,
  });
}

describe("the runner's signed assertion", () => {
  test("the shape the desktop runner sends is accepted", () => {
    expect(checkRunnerAssertion(text(), NOW)).toEqual({
      ok: true,
      assertion: { device_runner_id: RUNNER, iat_ms: NOW, nonce: NONCE },
    });
  });

  test("the audience must name the token exchange", () => {
    expect(checkRunnerAssertion(text({ aud: "cockpit" }), NOW)).toEqual({
      ok: false,
      code: "assertion_wrong_audience",
    });
  });

  test("a clock skew of up to 60 seconds either way is tolerated, no more", () => {
    for (const offset of [RUNNER_ASSERTION_SKEW_MS, -RUNNER_ASSERTION_SKEW_MS, 0])
      expect(checkRunnerAssertion(text(), NOW + offset).ok).toBe(true);
    for (const offset of [RUNNER_ASSERTION_SKEW_MS + 1, -RUNNER_ASSERTION_SKEW_MS - 1])
      expect(checkRunnerAssertion(text(), NOW + offset)).toEqual({
        ok: false,
        code: "assertion_out_of_time",
      });
  });

  test("the signed bytes must be the canonical form, so nothing else can be smuggled in", () => {
    const reordered = JSON.stringify({
      device_runner_id: RUNNER,
      aud: RUNNER_ASSERTION_AUDIENCE,
      iat: new Date(NOW).toISOString(),
      nonce: NONCE,
    });
    expect(checkRunnerAssertion(reordered, NOW)).toEqual({
      ok: false,
      code: "assertion_not_canonical",
    });
    expect(checkRunnerAssertion(` ${text()}`, NOW)).toEqual({
      ok: false,
      code: "assertion_not_canonical",
    });
  });

  test("anything else is malformed", () => {
    for (const bad of [
      "not json",
      "null",
      "[]",
      "42",
      text({ extra: true }),
      text({ device_runner_id: "runner-1" }),
      text({ device_runner_id: 7 }),
      text({ iat: "yesterday" }),
      text({ iat: "2026-11-21T10:00:00+01:00" }),
      text({ iat: 1 }),
      text({ nonce: "short" }),
      text({ nonce: `${NONCE}A` }),
      text({ nonce: "AAECAwQFBgcICQoLDA0OD=" }),
      text({ nonce: 5 }),
      text({ aud: 1 }),
      JSON.stringify({ aud: RUNNER_ASSERTION_AUDIENCE, device_runner_id: RUNNER, iat: "x" }),
    ])
      expect(checkRunnerAssertion(bad, NOW)).toEqual({ ok: false, code: "assertion_malformed" });
  });

  test("an impossible date is out of time, not accepted", () => {
    expect(checkRunnerAssertion(text({ iat: "2026-13-45T10:00:00.000Z" }), NOW)).toEqual({
      ok: false,
      code: "assertion_out_of_time",
    });
  });

  test("a nonce is remembered for the whole window it could be replayed in", () => {
    expect(nonceExpiresAt(NOW)).toBe(NOW + 120_000);
    expect(RUNNER_TOKEN_TTL_MS).toBe(600_000);
  });

  test("the audience and the token prefix are the ones the desktop runner uses", () => {
    expect(RUNNER_ASSERTION_AUDIENCE).toBe("device-runner-token");
    expect(RUNNER_TOKEN_PREFIX).toBe("skdr.");
  });

  test("an instant without milliseconds is accepted", () => {
    expect(checkRunnerAssertion(text({ iat: "2026-11-21T10:00:00Z" }), NOW).ok).toBe(true);
  });

  test("ids, instants and nonces must match whole, not as part of a longer value", () => {
    for (const bad of [
      text({ device_runner_id: `x${RUNNER}` }),
      text({ device_runner_id: `${RUNNER}x` }),
      text({ iat: `x${new Date(NOW).toISOString()}` }),
      text({ iat: `${new Date(NOW).toISOString()}x` }),
      text({ device_runner_id: [RUNNER] }),
      text({ iat: [new Date(NOW).toISOString()] }),
      text({ nonce: [NONCE] }),
      text({ aud: [RUNNER_ASSERTION_AUDIENCE] }),
    ])
      expect(checkRunnerAssertion(bad, NOW)).toEqual({ ok: false, code: "assertion_malformed" });
  });
});
