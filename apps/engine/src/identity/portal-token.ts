// Portal token utilities — generation, hashing, parsing.
//
// Format: `wf_portal_<32 url-safe chars>`. The first 14 chars (including the
// `wf_portal_` literal) are stored unhashed in the `portal_tokens.prefix`
// column so lookups stay indexed. The full token is stored only as a
// sha256 hex digest in `portal_tokens.token_sha256`. This mirrors the
// api-key helpers but keeps a distinct prefix literal so the
// AuthProviderRegistry can route by literal before falling through to
// the api-key provider.

import { randomBytes } from "node:crypto";
import { sha256Hex } from "./api-key.ts";

export const PORTAL_TOKEN_PREFIX_LITERAL = "wf_portal_";
// 10 chars literal + 4 rand chars = 14 total. Keeps the unique index
// discriminating without leaking too much of the token.
export const PORTAL_TOKEN_PREFIX_LENGTH = 14;

export interface IssuedPortalToken {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generatePortalToken(): IssuedPortalToken {
  // 24 random bytes -> 32 url-safe chars, matching api-key entropy.
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `${PORTAL_TOKEN_PREFIX_LITERAL}${rand}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, PORTAL_TOKEN_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}

export function parsePortalToken(plaintext: string): { prefix: string; hash: string } | null {
  if (!plaintext || typeof plaintext !== "string") return null;
  if (!plaintext.startsWith(PORTAL_TOKEN_PREFIX_LITERAL)) return null;
  if (plaintext.length < PORTAL_TOKEN_PREFIX_LENGTH + 8) return null;
  return {
    prefix: plaintext.slice(0, PORTAL_TOKEN_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}
