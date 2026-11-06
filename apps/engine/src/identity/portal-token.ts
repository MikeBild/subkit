import { randomBytes } from "node:crypto";
import { sha256Hex } from "./api-key.ts";

export const PORTAL_TOKEN_PREFIX_LITERAL = "wf_portal_";
export const PORTAL_TOKEN_PREFIX_LENGTH = 14;

interface IssuedPortalToken {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generatePortalToken(): IssuedPortalToken {
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
