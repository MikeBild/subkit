// Stripe native verifier.
//
// Stripe sends a single `Stripe-Signature` header shaped as
//   t=<unix-ts>,v1=<hex>,v1=<hex>,...
//
// The signed payload is `t + "." + raw_body`, signed with HMAC-SHA256
// using the endpoint secret. Stripe allows multiple v1 values during
// rotation; we accept if any of them matches.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifierResult, VerifyInput } from "./types.ts";

const STRIPE_REPLAY_WINDOW_SECONDS = 5 * 60;

export function verifyStripe(input: VerifyInput): VerifierResult {
  const header = input.headers["stripe-signature"];
  if (!header) {
    return { ok: false, reason: "missing_stripe_signature" };
  }
  let timestamp: number | null = null;
  const v1Sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (k === "t") timestamp = Number.parseInt(v, 10);
    if (k === "v1") v1Sigs.push(v);
  }
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return { ok: false, reason: "bad_stripe_timestamp" };
  }
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > STRIPE_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "timestamp_outside_window" };
  }
  if (v1Sigs.length === 0) {
    return { ok: false, reason: "no_v1_signature" };
  }
  const base = `${timestamp}.${input.rawBody}`;
  const expected = createHmac("sha256", input.secret).update(base, "utf8").digest("hex");
  const b = Buffer.from(expected, "hex");
  let matched = false;
  for (const sig of v1Sigs) {
    const a = Buffer.from(sig, "hex");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      matched = true;
      break;
    }
  }
  if (!matched) return { ok: false, reason: "bad_signature" };
  // Attempt to read the event id + type out of the body so dedup has
  // a stable key. Stripe ships `id` + `type` top-level on events.
  let id: string | null = null;
  let type = "unknown";
  try {
    const parsed = JSON.parse(input.rawBody) as { id?: unknown; type?: unknown };
    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.type === "string") type = parsed.type;
  } catch {
    /* fall through */
  }
  return {
    ok: true,
    normalized: {
      id: id ?? `stripe-${timestamp}`,
      timestamp,
      type,
    },
  };
}
