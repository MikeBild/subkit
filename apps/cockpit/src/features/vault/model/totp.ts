import { parseTotp } from "./entries";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Bytes(secret: string): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of secret) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error("not base32");
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const HASH = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" } as const;

export async function totpPreview(raw: string, unixMs: number): Promise<string | null> {
  const setup = parseTotp(raw);
  if (!setup) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    base32Bytes(setup.secret),
    { name: "HMAC", hash: HASH[setup.algorithm] },
    false,
    ["sign"],
  );
  const counter = Math.floor(unixMs / 1000 / setup.period);
  const message = new DataView(new ArrayBuffer(8));
  message.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  message.setUint32(4, counter % 0x1_0000_0000);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message.buffer));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** setup.digits).padStart(setup.digits, "0");
}

export function totpSecondsLeft(raw: string, unixMs: number): number {
  const period = parseTotp(raw)?.period ?? 30;
  return period - (Math.floor(unixMs / 1000) % period);
}
