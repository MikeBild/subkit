import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AES_IV_BYTES,
  activeMasterKeyDigest,
  decryptSecret,
  encryptSecret,
  parseMasterKeyHex,
  secureEqual,
} from "../aes-gcm.ts";

describe("aes-gcm", () => {
  test("roundtrip encrypt/decrypt preserves plaintext", () => {
    const plaintext = "hunter2-super-secret-\u{1F510}";
    const payload = encryptSecret(plaintext);
    expect(payload.iv.length).toBe(AES_IV_BYTES);
    expect(payload.auth_tag.length).toBe(16);
    expect(payload.ciphertext.length).toBeGreaterThan(0);
    const back = decryptSecret(payload);
    expect(back).toBe(plaintext);
  });

  test("each encrypt produces a fresh iv (nonce reuse free)", () => {
    const a = encryptSecret("abc");
    const b = encryptSecret("abc");
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  test("ciphertext never contains the plaintext bytes", () => {
    const plaintext = "topsecret-plain-ascii";
    const payload = encryptSecret(plaintext);
    const asHex = Buffer.from(payload.ciphertext).toString("hex");
    const plainHex = Buffer.from(plaintext, "utf8").toString("hex");
    expect(asHex.includes(plainHex)).toBe(false);
  });

  test("tampered ciphertext fails to decrypt", () => {
    const payload = encryptSecret("tamper-bait");
    const flipped = new Uint8Array(payload.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => decryptSecret({ ...payload, ciphertext: flipped })).toThrow(/decrypt failed/);
  });

  test("tampered iv fails to decrypt", () => {
    const payload = encryptSecret("iv-bait");
    const flipped = new Uint8Array(payload.iv);
    flipped[0] = flipped[0]! ^ 0x01;
    expect(() => decryptSecret({ ...payload, iv: flipped })).toThrow(/decrypt failed/);
  });

  test("tampered auth_tag fails to decrypt", () => {
    const payload = encryptSecret("tag-bait");
    const flipped = new Uint8Array(payload.auth_tag);
    flipped[0] = flipped[0]! ^ 0x80;
    expect(() => decryptSecret({ ...payload, auth_tag: flipped })).toThrow(/decrypt failed/);
  });

  test("aad binds ciphertext to context", () => {
    const payload = encryptSecret("bound", "tenant:abc");
    expect(decryptSecret(payload, "tenant:abc")).toBe("bound");
    expect(() => decryptSecret(payload, "tenant:xyz")).toThrow(/decrypt failed/);
    expect(() => decryptSecret(payload)).toThrow(/decrypt failed/);
  });

  test("secureEqual compares constant-time", () => {
    expect(secureEqual("foo", "foo")).toBe(true);
    expect(secureEqual("foo", "bar")).toBe(false);
    expect(secureEqual("foo", "foo-")).toBe(false);
  });
});

test("the master-key digest follows the cached crypto key rather than later environment edits", () => {
  const configured = process.env.MASTER_KEY;
  if (!configured) throw new Error("missing fixture master key");
  const expected = createHash("sha256").update(parseMasterKeyHex(configured)).digest("hex");
  const payload = encryptSecret("cached-key-fixture");
  expect(activeMasterKeyDigest()).toBe(expected);
  try {
    process.env.MASTER_KEY = "54".repeat(32);
    expect(activeMasterKeyDigest()).toBe(expected);
    expect(decryptSecret(payload)).toBe("cached-key-fixture");
  } finally {
    process.env.MASTER_KEY = configured;
  }
});
