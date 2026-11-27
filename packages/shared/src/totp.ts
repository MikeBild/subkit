import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpOptions {
  readonly digits?: number;
  readonly period?: number;
  readonly algorithm?: TotpAlgorithm;
}

export interface OtpauthParams {
  readonly secret: string;
  readonly digits: number;
  readonly period: number;
  readonly algorithm: TotpAlgorithm;
  readonly issuer: string | null;
  readonly account: string | null;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function normalizeBase32(seed: string): string {
  return seed.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

export function isBase32Seed(seed: string): boolean {
  const normalized = normalizeBase32(seed);
  return normalized.length >= 16 && /^[A-Z2-7]+$/.test(normalized);
}

export function base32Decode(seed: string): Uint8Array {
  const normalized = normalizeBase32(seed);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) throw new Error("the seed is not base32");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function counterBytes(counter: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  bytes.writeUInt32BE(counter % 0x1_0000_0000, 4);
  return bytes;
}

export function hotpCode(
  key: Uint8Array,
  counter: number,
  digits = 6,
  algorithm: TotpAlgorithm = "SHA1",
): string {
  const mac = createHmac(algorithm.toLowerCase(), key).update(counterBytes(counter)).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpCode(base32Seed: string, unixMs: number, options: TotpOptions = {}): string {
  const period = options.period ?? 30;
  const counter = Math.floor(unixMs / 1000 / period);
  return hotpCode(base32Decode(base32Seed), counter, options.digits ?? 6, options.algorithm);
}

function algorithmOf(raw: string | null): TotpAlgorithm | null {
  const value = (raw ?? "SHA1").toUpperCase();
  return value === "SHA1" || value === "SHA256" || value === "SHA512" ? value : null;
}

function positiveInt(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function parseOtpauth(uri: string): OtpauthParams | null {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp") return null;
  const secret = url.searchParams.get("secret");
  if (!secret || !isBase32Seed(secret)) return null;
  const digits = positiveInt(url.searchParams.get("digits"), 6);
  const period = positiveInt(url.searchParams.get("period"), 30);
  const algorithm = algorithmOf(url.searchParams.get("algorithm"));
  if (digits === null || digits < 6 || digits > 8 || period === null || algorithm === null) {
    return null;
  }
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const separator = label.indexOf(":");
  const account = (separator >= 0 ? label.slice(separator + 1) : label).trim() || null;
  const issuer =
    url.searchParams.get("issuer") ?? (separator >= 0 ? label.slice(0, separator).trim() : null);
  return {
    secret: normalizeBase32(secret),
    digits,
    period,
    algorithm,
    issuer: issuer || null,
    account,
  };
}

export function totpSeedFrom(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const parsed = parseOtpauth(trimmed);
    return parsed && parsed.digits === 6 && parsed.period === 30 && parsed.algorithm === "SHA1"
      ? parsed.secret
      : null;
  }
  return isBase32Seed(trimmed) ? normalizeBase32(trimmed) : null;
}
