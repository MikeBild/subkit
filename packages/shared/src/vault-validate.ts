export type CardBrand =
  | "visa"
  | "mastercard"
  | "amex"
  | "discover"
  | "diners"
  | "jcb"
  | "unionpay"
  | "maestro"
  | "unknown";

const PAN_SEPARATORS = /[\s-]/g;

export function panDigits(pan: string): string {
  return pan.replace(PAN_SEPARATORS, "");
}

export function luhnValid(pan: string): boolean {
  const digits = panDigits(pan);
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function prefixIn(digits: string, length: number, low: number, high: number): boolean {
  const prefix = Number(digits.slice(0, length));
  return digits.length >= length && prefix >= low && prefix <= high;
}

export function cardBrand(pan: string): CardBrand {
  const digits = panDigits(pan);
  if (!/^\d+$/.test(digits)) return "unknown";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^4/.test(digits)) return "visa";
  if (prefixIn(digits, 2, 51, 55) || prefixIn(digits, 4, 2221, 2720)) return "mastercard";
  if (/^(?:6011|65)/.test(digits) || prefixIn(digits, 3, 644, 649)) return "discover";
  if (/^(?:30[0-5]|309|36|38|39)/.test(digits)) return "diners";
  if (prefixIn(digits, 4, 3528, 3589)) return "jcb";
  if (/^62/.test(digits)) return "unionpay";
  if (/^(?:50|5[6-8]|6[0-9])/.test(digits)) return "maestro";
  return "unknown";
}

export function isCardNumber(pan: string): boolean {
  const digits = panDigits(pan);
  return digits.length >= 13 && luhnValid(digits) && cardBrand(digits) !== "unknown";
}

const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SC: 31,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
};

export function normalizeIban(iban: string): string {
  return iban.replace(/[\s-]/g, "").toUpperCase();
}

function ibanRemainder(rearranged: string): number {
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

export function ibanValid(iban: string): boolean {
  const normalized = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;
  const expected = IBAN_LENGTHS[normalized.slice(0, 2)];
  if (expected !== undefined && normalized.length !== expected) return false;
  return ibanRemainder(normalized.slice(4) + normalized.slice(0, 4)) === 1;
}

export function bicValid(bic: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic.trim().toUpperCase());
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

export function normalizeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.username || url.password) return null;
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return null;
  return url.origin.toLowerCase();
}

function wwwPair(a: URL, b: URL): boolean {
  if (a.protocol !== b.protocol || a.port !== b.port) return false;
  return a.hostname === `www.${b.hostname}` || b.hostname === `www.${a.hostname}`;
}

export function originMatches(itemOrigins: readonly string[], pageOrigin: string): boolean {
  const page = normalizeOrigin(pageOrigin);
  if (page === null) return false;
  const pageUrl = new URL(page);
  return itemOrigins.some((candidate) => {
    const origin = normalizeOrigin(candidate);
    if (origin === null) return false;
    return origin === page || wwwPair(new URL(origin), pageUrl);
  });
}

export function expiryInFuture(month: number, year: number, now: Date): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return false;
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return year * 12 + (month - 1) >= current;
}
