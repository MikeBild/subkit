// GitHub native verifier.
//
// GitHub signs webhooks with `X-Hub-Signature-256: sha256=<hex>`. The
// shared secret is the one configured in the GitHub repo/org webhook
// settings. There is no timestamp header, so there is no replay
// window — we lean on the `X-GitHub-Delivery` UUID for dedup.

import { createHmac, timingSafeEqual } from "node:crypto";
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
    return { ok: false, reason: "bad_signature" };
  }
  return {
    ok: true,
    normalized: {
      id: delivery,
      timestamp: Math.floor((input.now ?? Date.now()) / 1000),
      type: eventType ?? "unknown",
    },
  };
}
