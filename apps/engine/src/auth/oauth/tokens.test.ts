// Unit tests for MCP OAuth token helpers.
// Pure functions — no DB, no Docker.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ACCESS_TOKEN_PREFIX_LITERAL,
  constantTimeHexEquals,
  generateAccessToken,
  generateAuthorizationCode,
  generateRefreshToken,
  parseMcpToken,
  REFRESH_TOKEN_PREFIX_LITERAL,
  sha256Hex,
  TOKEN_PREFIX_LENGTH,
  verifyS256,
} from "./tokens.ts";

describe("generateAccessToken", () => {
  test("plaintext starts with wf_mcp_ prefix", () => {
    const t = generateAccessToken();
    expect(t.plaintext.startsWith(ACCESS_TOKEN_PREFIX_LITERAL)).toBe(true);
  });

  test("prefix is exactly the first TOKEN_PREFIX_LENGTH characters", () => {
    const t = generateAccessToken();
    expect(t.prefix).toBe(t.plaintext.slice(0, TOKEN_PREFIX_LENGTH));
    expect(t.prefix.length).toBe(TOKEN_PREFIX_LENGTH);
  });

  test("hash matches sha256Hex of plaintext", () => {
    const t = generateAccessToken();
    expect(t.hash).toBe(sha256Hex(t.plaintext));
  });

  test("two calls produce distinct tokens", () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  test("plaintext is long enough for parseMcpToken", () => {
    const t = generateAccessToken();
    expect(t.plaintext.length).toBeGreaterThanOrEqual(TOKEN_PREFIX_LENGTH + 8);
  });
});

describe("generateRefreshToken", () => {
  test("plaintext starts with wf_mcr_ prefix", () => {
    const t = generateRefreshToken();
    expect(t.plaintext.startsWith(REFRESH_TOKEN_PREFIX_LITERAL)).toBe(true);
  });

  test("prefix is exactly the first TOKEN_PREFIX_LENGTH characters", () => {
    const t = generateRefreshToken();
    expect(t.prefix).toBe(t.plaintext.slice(0, TOKEN_PREFIX_LENGTH));
    expect(t.prefix.length).toBe(TOKEN_PREFIX_LENGTH);
  });

  test("hash matches sha256Hex of plaintext", () => {
    const t = generateRefreshToken();
    expect(t.hash).toBe(sha256Hex(t.plaintext));
  });

  test("access and refresh tokens have different prefixes", () => {
    expect(ACCESS_TOKEN_PREFIX_LITERAL).not.toBe(REFRESH_TOKEN_PREFIX_LITERAL);
    const a = generateAccessToken();
    const r = generateRefreshToken();
    expect(a.prefix.startsWith(ACCESS_TOKEN_PREFIX_LITERAL)).toBe(true);
    expect(r.prefix.startsWith(REFRESH_TOKEN_PREFIX_LITERAL)).toBe(true);
  });
});

describe("generateAuthorizationCode", () => {
  test("plaintext is a non-empty base64url string", () => {
    const c = generateAuthorizationCode();
    expect(typeof c.plaintext).toBe("string");
    expect(c.plaintext.length).toBeGreaterThan(0);
  });

  test("hash matches sha256Hex of plaintext", () => {
    const c = generateAuthorizationCode();
    expect(c.hash).toBe(sha256Hex(c.plaintext));
  });

  test("two calls produce distinct codes", () => {
    const a = generateAuthorizationCode();
    const b = generateAuthorizationCode();
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe("sha256Hex", () => {
  test("produces correct hex digest", () => {
    const expected = createHash("sha256").update("hello").digest("hex");
    expect(sha256Hex("hello")).toBe(expected);
  });

  test("deterministic for same input", () => {
    expect(sha256Hex("test")).toBe(sha256Hex("test"));
  });

  test("different inputs produce different hashes", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("parseMcpToken", () => {
  test("returns kind=access for wf_mcp_ prefixed token", () => {
    const t = generateAccessToken();
    const parsed = parseMcpToken(t.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("access");
    expect(parsed?.prefix).toBe(t.prefix);
    expect(parsed?.hash).toBe(t.hash);
  });

  test("returns kind=refresh for wf_mcr_ prefixed token", () => {
    const t = generateRefreshToken();
    const parsed = parseMcpToken(t.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("refresh");
    expect(parsed?.prefix).toBe(t.prefix);
    expect(parsed?.hash).toBe(t.hash);
  });

  test("returns null for unknown prefix", () => {
    expect(parseMcpToken("wf_live_abcdefghijklmnopqrstuvwxyz012345")).toBeNull();
    expect(parseMcpToken("sk_test_abcdefghijklmnopqrstuvwxyz012345")).toBeNull();
    expect(parseMcpToken("")).toBeNull();
  });

  test("returns null for non-string input (null cast to any)", () => {
    // parseMcpToken has a typeof guard for non-string
    // biome-ignore lint/suspicious/noExplicitAny: testing guard
    expect(parseMcpToken(null as any)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: testing guard
    expect(parseMcpToken(undefined as any)).toBeNull();
  });

  test("returns null when token is too short (prefix only, no payload)", () => {
    // Token with only the prefix but fewer than TOKEN_PREFIX_LENGTH + 8 chars
    const shortAccess = `${ACCESS_TOKEN_PREFIX_LITERAL}abc`;
    expect(parseMcpToken(shortAccess)).toBeNull();

    const shortRefresh = `${REFRESH_TOKEN_PREFIX_LITERAL}abc`;
    expect(parseMcpToken(shortRefresh)).toBeNull();
  });

  test("hash in parsed result equals sha256Hex of plaintext", () => {
    const t = generateAccessToken();
    const parsed = parseMcpToken(t.plaintext);
    expect(parsed?.hash).toBe(sha256Hex(t.plaintext));
  });
});

describe("verifyS256 (PKCE)", () => {
  function makeChallenge(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
  }

  test("correct verifier passes", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = makeChallenge(verifier);
    expect(verifyS256(verifier, challenge)).toBe(true);
  });

  test("wrong verifier fails", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = makeChallenge(verifier);
    expect(verifyS256("wrong-verifier-value", challenge)).toBe(false);
  });

  test("empty verifier fails", () => {
    const challenge = makeChallenge("real-verifier");
    expect(verifyS256("", challenge)).toBe(false);
  });

  test("plain method string as verifier rejects (not a valid S256 verifier)", () => {
    // A "plain" method would pass the challenge as-is. verifyS256 always
    // hashes the verifier — so passing the raw challenge as the verifier
    // will not match (digest-of-digest != original challenge).
    const challenge = makeChallenge("some-verifier");
    // Passing the challenge itself as the verifier: sha256(challenge) != challenge
    expect(verifyS256(challenge, challenge)).toBe(false);
  });

  test("different challenges same verifier: fails", () => {
    const verifier = "my-test-verifier-12345678901234567890";
    const correctChallenge = makeChallenge(verifier);
    const wrongChallenge = makeChallenge("other-verifier");
    expect(verifyS256(verifier, correctChallenge)).toBe(true);
    expect(verifyS256(verifier, wrongChallenge)).toBe(false);
  });
});

describe("constantTimeHexEquals", () => {
  test("equal strings return true", () => {
    const h = sha256Hex("test");
    expect(constantTimeHexEquals(h, h)).toBe(true);
  });

  test("different strings return false", () => {
    const a = sha256Hex("a");
    const b = sha256Hex("b");
    expect(constantTimeHexEquals(a, b)).toBe(false);
  });

  test("different lengths return false without timing side-channel", () => {
    expect(constantTimeHexEquals("abc", "abcd")).toBe(false);
  });
});
