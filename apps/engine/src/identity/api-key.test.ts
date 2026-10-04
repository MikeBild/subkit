import { describe, expect, test } from "bun:test";
import {
  constantTimeHexEquals,
  generateKey,
  hashKey,
  KEY_PREFIX_LENGTH,
  KEY_PREFIX_LITERAL,
  parseKey,
  sha256Hex,
} from "./api-key.ts";

describe("sha256Hex", () => {
  test("produces a 64-char lowercase hex digest", () => {
    const out = sha256Hex("hello");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same input", () => {
    expect(sha256Hex("subkit")).toBe(sha256Hex("subkit"));
  });

  test("differs across distinct inputs", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("generateKey", () => {
  test("emits a key with the wf_live_ prefix and 40 total chars", () => {
    const key = generateKey();
    expect(key.plaintext.startsWith(KEY_PREFIX_LITERAL)).toBe(true);
    expect(key.plaintext.length).toBe(KEY_PREFIX_LITERAL.length + 32);
  });

  test("prefix slice equals the first KEY_PREFIX_LENGTH characters", () => {
    const key = generateKey();
    expect(key.prefix).toBe(key.plaintext.slice(0, KEY_PREFIX_LENGTH));
    expect(key.prefix.length).toBe(KEY_PREFIX_LENGTH);
  });

  test("hash is the sha256 hex of the plaintext", () => {
    const key = generateKey();
    expect(key.hash).toBe(sha256Hex(key.plaintext));
  });

  test("emits a fresh random suffix on every call", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("parseKey", () => {
  test("returns prefix + hash for a well-formed key", () => {
    const key = generateKey();
    const parsed = parseKey(key.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe(key.prefix);
    expect(parsed?.hash).toBe(key.hash);
  });

  test("rejects null, empty, and non-string inputs", () => {
    expect(parseKey("")).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately probing the runtime guard
    expect(parseKey(null as any)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately probing the runtime guard
    expect(parseKey(undefined as any)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately probing the runtime guard
    expect(parseKey(42 as any)).toBeNull();
  });

  test("rejects strings without the wf_live_ prefix", () => {
    expect(parseKey("not_a_key_at_all")).toBeNull();
    expect(parseKey("wf_portal_abcdefghijklmnop")).toBeNull();
  });

  test("rejects too-short strings even when the prefix matches", () => {
    expect(parseKey(KEY_PREFIX_LITERAL)).toBeNull();
    expect(parseKey(`${KEY_PREFIX_LITERAL}abc`)).toBeNull();
  });
});

describe("hashKey", () => {
  test("matches sha256Hex for the same input", () => {
    expect(hashKey("wf_live_test")).toBe(sha256Hex("wf_live_test"));
  });
});

describe("constantTimeHexEquals", () => {
  test("returns true for identical hex digests", () => {
    const a = sha256Hex("same");
    expect(constantTimeHexEquals(a, a)).toBe(true);
  });

  test("returns false for different hex digests of equal length", () => {
    const a = sha256Hex("a");
    const b = sha256Hex("b");
    expect(constantTimeHexEquals(a, b)).toBe(false);
  });

  test("returns false when lengths differ (no throw)", () => {
    expect(constantTimeHexEquals("aa", "aabb")).toBe(false);
  });

  test("returns false for invalid hex (Buffer.from coerces silently)", () => {
    expect(
      constantTimeHexEquals(
        "not-hex-at-all-but-64-chars-wide-not-hex-at-all-but-64-chars-wid",
        sha256Hex("x"),
      ),
    ).toBe(false);
  });
});
