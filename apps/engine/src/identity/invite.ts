import { randomBytes } from "node:crypto";
import { sha256Hex } from "./api-key.ts";

export const INVITE_TOKEN_PREFIX_LITERAL = "wf_invite_";
export const INVITE_TOKEN_PREFIX_LENGTH = 14;

interface IssuedInviteToken {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generateInviteToken(): IssuedInviteToken {
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
