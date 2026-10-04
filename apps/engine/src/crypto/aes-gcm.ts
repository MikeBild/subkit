import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { logger } from "../logging/logger.ts";

export const AES_ALGORITHM = "aes-256-gcm" as const;
export const AES_KEY_BYTES = 32;
export const AES_IV_BYTES = 12;
export const AES_AUTH_TAG_BYTES = 16;

export class CryptoError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "key_length"
      | "decrypt_failed"
      | "auth_tag_length"
      | "iv_length"
      | "aad_mismatch",
  ) {
    super(message);
    this.name = "CryptoError";
  }
}

export function parseMasterKeyHex(hex: string): Buffer {
  return parseKey(hex);
}

function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CryptoError("MASTER_KEY must be exactly 64 hex characters (32 bytes)", "key_length");
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== AES_KEY_BYTES) {
    throw new CryptoError(
      `MASTER_KEY decoded to ${buf.length} bytes, expected ${AES_KEY_BYTES}`,
      "key_length",
    );
  }
  return buf;
}

function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

let cachedKey: Buffer | null = null;
let loggedLoad = false;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.MASTER_KEY ?? "";
  cachedKey = parseKey(raw);
  if (!loggedLoad) {
    loggedLoad = true;
    logger.info({
      module: "crypto",
      action: "crypto.key.loaded",
      msg: "AES-256-GCM master key loaded",
      algorithm: AES_ALGORITHM,
      key_fingerprint: keyFingerprint(cachedKey),
    });
  }
  return cachedKey;
}

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
}

export function encryptSecret(plaintext: string, aad?: string): EncryptedPayload {
  return encryptSecretWithKey(getKey(), plaintext, aad);
}

export function secretComparisonProof(domain: string, plaintext: string): string {
  return createHmac("sha256", getKey())
    .update(JSON.stringify([domain, plaintext]))
    .digest("hex");
}

export function encryptSecretWithKey(
  key: Buffer,
  plaintext: string,
  aad?: string,
): EncryptedPayload {
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, {
    authTagLength: AES_AUTH_TAG_BYTES,
  });
  if (aad) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const auth_tag = cipher.getAuthTag();
  if (auth_tag.length !== AES_AUTH_TAG_BYTES) {
    throw new CryptoError(
      `authTag length ${auth_tag.length}, expected ${AES_AUTH_TAG_BYTES}`,
      "auth_tag_length",
    );
  }
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    auth_tag: new Uint8Array(auth_tag),
  };
}

export function decryptSecret(payload: EncryptedPayload, aad?: string): string {
  return decryptSecretWithKey(getKey(), payload, aad);
}

export function decryptSecretWithKey(key: Buffer, payload: EncryptedPayload, aad?: string): string {
  if (payload.iv.length !== AES_IV_BYTES) {
    throw new CryptoError(`iv length ${payload.iv.length}, expected ${AES_IV_BYTES}`, "iv_length");
  }
  if (payload.auth_tag.length !== AES_AUTH_TAG_BYTES) {
    throw new CryptoError(
      `auth_tag length ${payload.auth_tag.length}, expected ${AES_AUTH_TAG_BYTES}`,
      "auth_tag_length",
    );
  }
  const decipher = createDecipheriv(AES_ALGORITHM, key, Buffer.from(payload.iv), {
    authTagLength: AES_AUTH_TAG_BYTES,
  });
  if (aad) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }
  decipher.setAuthTag(Buffer.from(payload.auth_tag));
  try {
    const out = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext)), decipher.final()]);
    return out.toString("utf8");
  } catch (err) {
    throw new CryptoError(
      `decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
      "decrypt_failed",
    );
  }
}

export function secureEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const ba = typeof a === "string" ? Buffer.from(a, "utf8") : Buffer.from(a);
  const bb = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export const BOOTSTRAP_ONLY_ENV_KEYS = ["MASTER_KEY"] as const;

type _AssertSingleBootstrapEnv = typeof BOOTSTRAP_ONLY_ENV_KEYS extends readonly ["MASTER_KEY"]
  ? true
  : never;
const _bootstrapEnvShapeCheck: _AssertSingleBootstrapEnv = true;
void _bootstrapEnvShapeCheck;

export function assertCryptoKeyOrExit(): void {
  getKey();
}
