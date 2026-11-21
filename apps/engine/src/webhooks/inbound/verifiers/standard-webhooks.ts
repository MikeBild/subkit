import { logger } from "../../../logging/index.ts";
import { verifySignatureHeader } from "../../outbound/signer.ts";
import type { VerifierResult, VerifyInput } from "./types.ts";

const STANDARD_REPLAY_WINDOW_SECONDS = 5 * 60;

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
    logger.warn({
      module: "webhooks.inbound",
      action: "verify_failed",
      verifier: "standard-webhooks",
      reason: "bad_signature",
    });
    return { ok: false, reason: "bad_signature" };
  }
  logger.debug({
    module: "webhooks.inbound",
    action: "verified",
    verifier: "standard-webhooks",
    webhook_id: id,
    type: input.headers["webhook-type"] ?? "unknown",
  });
  return {
    ok: true,
    normalized: {
      id,
      timestamp: tsNum,
      type: (input.headers["webhook-type"] ?? "unknown") as string,
    },
  };
}
