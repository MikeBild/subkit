import { RUNNER_ASSERTION_AUDIENCE } from "@shared/device/runner-wire.ts";

export const RUNNER_ASSERTION_SKEW_MS = 60_000;
export const RUNNER_TOKEN_TTL_MS = 10 * 60_000;
export const RUNNER_TOKEN_PREFIX = "skdr.";

const NONCE = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type AssertionRefusal =
  | "assertion_malformed"
  | "assertion_not_canonical"
  | "assertion_wrong_audience"
  | "assertion_out_of_time";

export interface RunnerAssertion {
  device_runner_id: string;
  iat_ms: number;
  nonce: string;
}

export type AssertionCheck =
  | { ok: true; assertion: RunnerAssertion }
  | { ok: false; code: AssertionRefusal };

function record(text: string): Record<string, unknown> {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {}
  return Object(value) as Record<string, unknown>;
}

export function checkRunnerAssertion(text: string, now_ms: number): AssertionCheck {
  const body = record(text);
  const { aud, device_runner_id, iat, nonce } = body;
  if (
    Object.keys(body).length !== 4 ||
    typeof device_runner_id !== "string" ||
    !UUID.test(device_runner_id) ||
    typeof iat !== "string" ||
    !ISO_INSTANT.test(iat) ||
    typeof nonce !== "string" ||
    !NONCE.test(nonce) ||
    typeof aud !== "string"
  )
    return { ok: false, code: "assertion_malformed" };
  if (aud !== RUNNER_ASSERTION_AUDIENCE) return { ok: false, code: "assertion_wrong_audience" };
  if (JSON.stringify({ aud, device_runner_id, iat, nonce }) !== text)
    return { ok: false, code: "assertion_not_canonical" };
  const iat_ms = Date.parse(iat);
  if (Number.isNaN(iat_ms) || Math.abs(now_ms - iat_ms) > RUNNER_ASSERTION_SKEW_MS)
    return { ok: false, code: "assertion_out_of_time" };
  return { ok: true, assertion: { device_runner_id, iat_ms, nonce } };
}

export function nonceExpiresAt(iat_ms: number): number {
  return iat_ms + 2 * RUNNER_ASSERTION_SKEW_MS;
}
