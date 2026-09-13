// Portal-token utilities — generation, parsing, prefix discrimination.
//
// Portal tokens share the api-key sha256 hashing helper but live under
// a distinct prefix literal (`wf_portal_`) so the auth registry can
// route by literal before falling through to the api-key provider.
// These tests pin both invariants.

import { describe, expect, test } from "bun:test";

import { sha256Hex } from "./api-key.ts";
import {
  generatePortalToken,
  parsePortalToken,
  PORTAL_TOKEN_PREFIX_LENGTH,
  PORTAL_TOKEN_PREFIX_LITERAL,
} from "./portal-token.ts";

describe("generatePortalToken", () => {
  test("emits a token with the wf_portal_ prefix and 42 total chars", () => {
    const tok = generatePortalToken();
    expect(tok.plaintext.startsWith(PORTAL_TOKEN_PREFIX_LITERAL)).toBe(true);
    expect(tok.plaintext.length).toBe(PORTAL_TOKEN_PREFIX_LITERAL.length + 32);
  });

  test("prefix slice equals the first PORTAL_TOKEN_PREFIX_LENGTH chars", () => {
    const tok = generatePortalToken();
    expect(tok.prefix).toBe(tok.plaintext.slice(0, PORTAL_TOKEN_PREFIX_LENGTH));
    expect(tok.prefix.length).toBe(PORTAL_TOKEN_PREFIX_LENGTH);
  });

  test("hash is the sha256 hex of the plaintext", () => {
    const tok = generatePortalToken();
    expect(tok.hash).toBe(sha256Hex(tok.plaintext));
  });

  test("emits a fresh random suffix on every call", () => {
    const a = generatePortalToken();
    const b = generatePortalToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("parsePortalToken", () => {
  test("returns prefix + hash for a well-formed token", () => {
    const tok = generatePortalToken();
    const parsed = parsePortalToken(tok.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe(tok.prefix);
    expect(parsed?.hash).toBe(tok.hash);
  });

  test("rejects null, empty, and non-string inputs", () => {
    expect(parsePortalToken("")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probing the runtime guard
    expect(parsePortalToken(null as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probing the runtime guard
    expect(parsePortalToken(undefined as any)).toBeNull();
  });

  test("rejects api-key prefix even though sha256 matches the format", () => {
    // The auth registry routes by literal before hashing, so an api-key
    // plaintext must NOT parse as a portal token.
    expect(parsePortalToken("wf_live_abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
  });

  test("rejects too-short strings even when the prefix matches", () => {
    expect(parsePortalToken(PORTAL_TOKEN_PREFIX_LITERAL)).toBeNull();
    expect(parsePortalToken(`${PORTAL_TOKEN_PREFIX_LITERAL}abc`)).toBeNull();
  });
});
