// Default Standard Webhooks verifier.
//
//   * headers:  `webhook-id`, `webhook-timestamp`, `webhook-signature`
//   * base:     `${webhook_id}.${timestamp}.${raw_body}`
//   * signature must be `v1,<base64(HMAC-SHA256(secret, base))>`
//   * reject if `|now - timestamp| > 5 minutes`

import { verifySignatureHeader } from "../../outbound/signer.ts";
import type { VerifierResult, VerifyInput } from "./types.ts";

export const STANDARD_REPLAY_WINDOW_SECONDS = 5 * 60;

export function verifyStandard(input: VerifyInput): VerifierResult {
  const id = input.headers["webhook-id"];
  const ts = input.headers["webhook-timestamp"];
  const sig = input.headers["webhook-signature"];
  if (!id || !ts || !sig) {
    return { ok: false, reason: "missing_standard_webhooks_headers" };
  }
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - tsNum) > STANDARD_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "timestamp_outside_window" };
  }
  const base = `${id}.${ts}.${input.rawBody}`;
  if (!verifySignatureHeader(sig, base, [input.secret])) {
    return { ok: false, reason: "bad_signature" };
  }
  return {
    ok: true,
    normalized: {
      id,
      timestamp: tsNum,
      type: (input.headers["webhook-type"] ?? "unknown") as string,
    },
  };
}
