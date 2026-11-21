import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../../../logging/index.ts";
import type { VerifierResult, VerifyInput } from "./types.ts";

export function verifyGitHub(input: VerifyInput): VerifierResult {
  const sig = input.headers["x-hub-signature-256"];
  const delivery = input.headers["x-github-delivery"];
  const eventType = input.headers["x-github-event"];
  if (!sig || !delivery) {
    return { ok: false, reason: "missing_github_headers" };
  }
  const [scheme, hex] = sig.split("=");
  if (scheme !== "sha256" || !hex) {
    return { ok: false, reason: "bad_github_signature_format" };
  }
  const expected = createHmac("sha256", input.secret).update(input.rawBody, "utf8").digest("hex");
  const a = Buffer.from(hex, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn({
      module: "webhooks.inbound",
      action: "verify_failed",
      verifier: "github",
      delivery,
      reason: "bad_signature",
    });
    return { ok: false, reason: "bad_signature" };
  }
  logger.debug({
    module: "webhooks.inbound",
    action: "verified",
    verifier: "github",
    delivery,
    type: eventType ?? "unknown",
  });
  return {
    ok: true,
    normalized: {
      id: delivery,
      timestamp: Math.floor((input.now ?? Date.now()) / 1000),
      type: eventType ?? "unknown",
    },
  };
}
