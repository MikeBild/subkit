import { createHmac, timingSafeEqual } from "node:crypto";

interface SlackVerifyOptions {
  signingSecret: string;
  maxSkewSeconds?: number;
  now?: () => number;
}

interface SlackVerifyInput {
  timestamp: string | null;
  signature: string | null;
  body: string;
}

type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale" | "bad_signature" };

export function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
): string {
  const base = `v0:${timestamp}:${body}`;
  const mac = createHmac("sha256", signingSecret).update(base).digest("hex");
  return `v0=${mac}`;
}

export function verifySlackRequest(
  input: SlackVerifyInput,
  opts: SlackVerifyOptions,
): SlackVerifyResult {
  if (!input.timestamp || !input.signature) {
    return { ok: false, reason: "missing_headers" };
  }
  const ts = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "missing_headers" };
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  const skew = opts.maxSkewSeconds ?? 5 * 60;
  if (Math.abs(nowSec - ts) > skew) return { ok: false, reason: "stale" };

  const expected = computeSlackSignature(opts.signingSecret, input.timestamp, input.body);
  if (expected.length !== input.signature.length) return { ok: false, reason: "bad_signature" };
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  if (a.length !== b.length) return { ok: false, reason: "bad_signature" };
  const match = timingSafeEqual(a, b);
  return match ? { ok: true } : { ok: false, reason: "bad_signature" };
}
