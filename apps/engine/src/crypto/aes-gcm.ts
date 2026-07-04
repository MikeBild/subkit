// AES-256-GCM at-rest encryption for secrets.
//
// Uses Node's built-in `crypto` module (NOT WebCrypto) because GCM's
// authTag is exposed as a separate buffer, which is exactly what the
// credentials schema stores (ciphertext + iv + auth_tag triples).
//
// IV is a random 12 bytes per encrypt. Auth tag is 16 bytes. `aad`
// (additional authenticated data) binds a ciphertext to its logical
// context — passing `tenant_id:credential_id` prevents a ciphertext from
// being lifted out of one credential row and replayed into another.
//
// The master key is loaded once at module load from `env.MASTER_KEY`
// (validated by the zod schema at boot). A short fingerprint (first 8
// hex chars of SHA-256) is logged so operators can tell which key is in
// use without exposing the key itself.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
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

/**
 * Encrypt a UTF-8 plaintext with AES-256-GCM. `aad` is optional — pass
 * `tenant_id:credential_id` to bind a ciphertext to its row so it can't
 * be lifted and replayed under a different identity.
 */
export function encryptSecret(plaintext: string, aad?: string): EncryptedPayload {
  const key = getKey();
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

/**
 * Decrypt a payload produced by `encryptSecret`. Tamper, AAD mismatch,
 * or wrong key all throw `CryptoError("decrypt_failed")`.
 */
export function decryptSecret(payload: EncryptedPayload, aad?: string): string {
  const key = getKey();
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

/**
 * Constant-time comparison helper for secret-equality checks (e.g. to
 * verify a plaintext matches a ciphertext without leaking timing info).
 */
export function secureEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const ba = typeof a === "string" ? Buffer.from(a, "utf8") : Buffer.from(a);
  const bb = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Eager key validation moved to runServer() — module load must not
// touch env.MASTER_KEY so that arg-only flags (`engine --smoke`,
// `engine --version`, `engine --check-update`, `engine --self-update`)
// run on a binary that has not yet been configured. Operators still
// get the loud-on-boot guarantee via `assertCryptoKeyOrExit()`.

/**
 * Env vars that intentionally bypass the `getConfig()` snapshot in
 * the engine: their consumer runs BEFORE the config loader. Today
 * that's only MASTER_KEY (consumed by `assertCryptoKeyOrExit()`
 * below). Hot-rotating MASTER_KEY via `sk settings set` would render
 * every previously-encrypted credential unreadable on next boot, so
 * the leaf is intentionally NOT in subkit.config.json.
 *
 * `apps/engine/src/http/routes/diagnostics/setup.ts:buildCryptoSection`
 * imports this list to document the exception in its surface; adding
 * to this list is a deliberate, reviewable change (every caller
 * grep's the symbol).
 */
export const BOOTSTRAP_ONLY_ENV_KEYS = ["MASTER_KEY"] as const;

// Type-level fence: tsc fails if the tuple's shape changes without
// updating the buildCryptoSection consumer (which renders one row
// per entry in the diagnostic and currently knows the MASTER_KEY
// shape). Catches a future addition at typecheck time, not at
// first-request runtime. The runtime assert in setup.ts is
// belt-and-braces.
type _AssertSingleBootstrapEnv = typeof BOOTSTRAP_ONLY_ENV_KEYS extends readonly ["MASTER_KEY"]
  ? true
  : never;
const _bootstrapEnvShapeCheck: _AssertSingleBootstrapEnv = true;
void _bootstrapEnvShapeCheck;

/**
 * Force a key parse + cache. Call once during server startup so a bad
 * MASTER_KEY surfaces in the boot log, before any request can reach an
 * encrypt/decrypt path. Reads `process.env.MASTER_KEY` because that
 * env var is the only entry in `BOOTSTRAP_ONLY_ENV_KEYS` — the config
 * loader has not run yet.
 */
export function assertCryptoKeyOrExit(): void {
  getKey();
}
