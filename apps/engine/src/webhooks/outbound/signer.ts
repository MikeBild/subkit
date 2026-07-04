// Standard Webhooks signer.
//
// Signature base string:  `${webhook_id}.${timestamp}.${body}`
// Digest:                  HMAC-SHA256 with the subscription secret
// Header encoding:         `v1,<base64(digest)>`
//
// During secret rotation a subscription may carry a primary AND a
// rotating secret. The header becomes `v1,<old> v1,<new>` (space
// separated) so receivers see both candidates and can accept either.

import { createHmac } from "node:crypto";

export interface SignedEnvelope {
  webhook_id: string;
  timestamp: string; // unix seconds as a string — matches the spec wire format
  body: string;
  /** Header value. Space-separates multiple `v1,<b64>` tokens. */
  signature: string;
}

export interface SignOptions {
  webhook_id: string;
  timestamp: number; // unix seconds
  body: string;
  /** Primary secret (current). Used first in the multi-sig list. */
  secret: string;
  /** Optional rotating secret (previous). Appended after the primary. */
  rotatingSecret?: string | null;
}

function hmacBase64(secret: string, base: string): string {
  return createHmac("sha256", secret).update(base, "utf8").digest("base64");
}

export function sign(opts: SignOptions): SignedEnvelope {
  const ts = String(opts.timestamp);
  const base = `${opts.webhook_id}.${ts}.${opts.body}`;
  const parts: string[] = [`v1,${hmacBase64(opts.secret, base)}`];
  if (opts.rotatingSecret) {
    parts.push(`v1,${hmacBase64(opts.rotatingSecret, base)}`);
  }
  return {
    webhook_id: opts.webhook_id,
    timestamp: ts,
    body: opts.body,
    signature: parts.join(" "),
  };
}

/** Just the header value — convenience for tests + delivery worker. */
export function signatureHeader(opts: SignOptions): string {
  return sign(opts).signature;
}

/**
 * Constant-time check that `header` contains a valid `v1,<b64>` token
 * for the given base string and one of the candidate secrets. Used by
 * the inbound verifier.
 */
export function verifySignatureHeader(header: string, base: string, secrets: string[]): boolean {
  const tokens = header.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    const [scheme, b64] = token.split(",");
    if (scheme !== "v1" || !b64) continue;
    for (const secret of secrets) {
      const expected = hmacBase64(secret, base);
      if (constantTimeEqual(b64, expected)) return true;
    }
  }
  return false;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
