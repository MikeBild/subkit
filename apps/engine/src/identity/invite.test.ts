import { describe, expect, test } from "bun:test";
import { sha256Hex } from "./api-key.ts";
import {
  generateInviteToken,
  INVITE_TOKEN_PREFIX_LENGTH,
  INVITE_TOKEN_PREFIX_LITERAL,
  parseInviteToken,
} from "./invite.ts";

describe("generateInviteToken", () => {
  test("emits a token with the wf_invite_ prefix and 42 total chars", () => {
    const tok = generateInviteToken();
    expect(tok.plaintext.startsWith(INVITE_TOKEN_PREFIX_LITERAL)).toBe(true);
    expect(tok.plaintext.length).toBe(INVITE_TOKEN_PREFIX_LITERAL.length + 32);
  });

  test("prefix slice equals the first INVITE_TOKEN_PREFIX_LENGTH chars", () => {
    const tok = generateInviteToken();
    expect(tok.prefix).toBe(tok.plaintext.slice(0, INVITE_TOKEN_PREFIX_LENGTH));
    expect(tok.prefix.length).toBe(INVITE_TOKEN_PREFIX_LENGTH);
  });

  test("hash is the sha256 hex of the plaintext", () => {
    const tok = generateInviteToken();
    expect(tok.hash).toBe(sha256Hex(tok.plaintext));
  });

  test("emits a fresh random suffix on every call", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("parseInviteToken", () => {
  test("returns prefix + hash for a well-formed token", () => {
    const tok = generateInviteToken();
    const parsed = parseInviteToken(tok.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe(tok.prefix);
    expect(parsed?.hash).toBe(tok.hash);
  });

  test("rejects null, empty, and non-string inputs", () => {
    expect(parseInviteToken("")).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: probing the runtime guard
    expect(parseInviteToken(null as any)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: probing the runtime guard
    expect(parseInviteToken(undefined as any)).toBeNull();
  });

  test("rejects api-key and portal-token prefixes", () => {
    expect(parseInviteToken("wf_live_abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
    expect(parseInviteToken("wf_portal_abcdefghijklmnopqrstuvwxyz1234")).toBeNull();
  });

  test("rejects too-short strings even when the prefix matches", () => {
    expect(parseInviteToken(INVITE_TOKEN_PREFIX_LITERAL)).toBeNull();
    expect(parseInviteToken(`${INVITE_TOKEN_PREFIX_LITERAL}abc`)).toBeNull();
  });
});
