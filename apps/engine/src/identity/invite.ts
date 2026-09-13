// User-invite token utilities — generation, hashing, parsing.
//
// Format: `wf_invite_<32 url-safe chars>`. The first 14 chars (including
// the `wf_invite_` literal) are stored unhashed in the
// `user_invites.prefix` column so lookups stay indexed. The full token is
// stored only as a sha256 hex digest in `user_invites.token_sha256`. This
// mirrors the portal-token + api-key helpers but keeps a distinct prefix
// literal so an invite token can never be mistaken for a live api key or a
// portal token at the auth boundary — the invite is redeemed at a single
// dedicated endpoint, never presented as a bearer credential.

import { randomBytes } from "node:crypto";

import { sha256Hex } from "./api-key.ts";

export const INVITE_TOKEN_PREFIX_LITERAL = "wf_invite_";
// 10 chars literal + 4 rand chars = 14 total. Keeps the unique index
// discriminating without leaking too much of the token.
export const INVITE_TOKEN_PREFIX_LENGTH = 14;

export interface IssuedInviteToken {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generateInviteToken(): IssuedInviteToken {
  // 24 random bytes -> 32 url-safe chars, matching api-key entropy.
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `${INVITE_TOKEN_PREFIX_LITERAL}${rand}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, INVITE_TOKEN_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}

export function parseInviteToken(plaintext: string): { prefix: string; hash: string } | null {
  if (!plaintext || typeof plaintext !== "string") return null;
  if (!plaintext.startsWith(INVITE_TOKEN_PREFIX_LITERAL)) return null;
  if (plaintext.length < INVITE_TOKEN_PREFIX_LENGTH + 8) return null;
  return {
    prefix: plaintext.slice(0, INVITE_TOKEN_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}
