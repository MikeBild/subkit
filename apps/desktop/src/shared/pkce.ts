import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function challengeFor(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier, "ascii").digest());
}

export function createPkcePair(entropy: Uint8Array = randomBytes(32)): PkcePair {
  if (entropy.length < 32) throw new Error("PKCE verifier needs at least 32 bytes of entropy");
  const verifier = base64Url(entropy);
  return { verifier, challenge: challengeFor(verifier), method: "S256" };
}

export function createState(entropy: Uint8Array = randomBytes(24)): string {
  if (entropy.length < 16) throw new Error("Login state needs at least 16 bytes of entropy");
  return base64Url(entropy);
}

export function sameState(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
