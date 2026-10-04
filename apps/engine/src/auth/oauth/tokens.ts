import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../../identity/api-key.ts";

export { sha256Hex };

export const ACCESS_TOKEN_PREFIX_LITERAL = "wf_mcp_";
export const REFRESH_TOKEN_PREFIX_LITERAL = "wf_mcr_";
export const TOKEN_PREFIX_LENGTH = 12;

export interface IssuedMcpToken {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generateAccessToken(): IssuedMcpToken {
  const rand = randomBytes(24).toString("base64url");
  const plaintext = `${ACCESS_TOKEN_PREFIX_LITERAL}${rand}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, TOKEN_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}

export function generateRefreshToken(): IssuedMcpToken {
  const rand = randomBytes(24).toString("base64url");
  const plaintext = `${REFRESH_TOKEN_PREFIX_LITERAL}${rand}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, TOKEN_PREFIX_LENGTH),
    hash: sha256Hex(plaintext),
  };
}

export interface IssuedAuthCode {
  plaintext: string;
  hash: string;
}

export function generateAuthorizationCode(): IssuedAuthCode {
  const plaintext = randomBytes(32).toString("base64url");
  return { plaintext, hash: sha256Hex(plaintext) };
}

export interface ParsedMcpToken {
  prefix: string;
  hash: string;
  kind: "access" | "refresh";
}

export function parseMcpToken(plaintext: string): ParsedMcpToken | null {
  if (typeof plaintext !== "string") return null;
  if (
    plaintext.startsWith(ACCESS_TOKEN_PREFIX_LITERAL) &&
    plaintext.length >= TOKEN_PREFIX_LENGTH + 8
  ) {
    return {
      prefix: plaintext.slice(0, TOKEN_PREFIX_LENGTH),
      hash: sha256Hex(plaintext),
      kind: "access",
    };
  }
  if (
    plaintext.startsWith(REFRESH_TOKEN_PREFIX_LITERAL) &&
    plaintext.length >= TOKEN_PREFIX_LENGTH + 8
  ) {
    return {
      prefix: plaintext.slice(0, TOKEN_PREFIX_LENGTH),
      hash: sha256Hex(plaintext),
      kind: "refresh",
    };
  }
  return null;
}

export function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyS256(verifier: string, challenge: string): boolean {
  const digest = createHash("sha256").update(verifier).digest("base64url");
  if (digest.length !== challenge.length) return false;
  const a = Buffer.from(digest, "base64url");
  const b = Buffer.from(challenge, "base64url");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
