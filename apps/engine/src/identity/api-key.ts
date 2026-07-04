// API key utilities — generation, hashing, parsing.
//
// Format: `wf_live_<32 url-safe chars>`. The first 12 chars (including the
// `wf_live_` prefix) are stored unhashed in the `prefix` column so we can
// look the row up without scanning the whole table. The full token is
// stored only as a sha256 hex digest in `token_sha256`.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_PREFIX_LITERAL = "wf_live_";
export const KEY_PREFIX_LENGTH = 12;

export interface IssuedKey {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateKey(): IssuedKey {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `${KEY_PREFIX_LITERAL}${rand}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, KEY_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}

export function hashKey(plaintext: string): string {
  return sha256Hex(plaintext);
}

export function parseKey(plaintext: string): { prefix: string; hash: string } | null {
  if (!plaintext || typeof plaintext !== "string") return null;
  if (!plaintext.startsWith(KEY_PREFIX_LITERAL)) return null;
  if (plaintext.length < KEY_PREFIX_LENGTH + 8) return null;
  return {
    prefix: plaintext.slice(0, KEY_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}

/**
 * Constant-time hex string comparison. Throws if lengths differ — callers
 * should pre-check the prefix to avoid leaking that the row exists.
 */
export function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
