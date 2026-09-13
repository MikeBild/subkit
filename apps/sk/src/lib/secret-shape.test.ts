// Unit tests for the input-side credential filter.
//
// These run on the literal `detectSecretShape` function — no Ink, no
// network — so we can scan a wide table of fixtures fast. Each fixture
// pairs a sample token against the expected `kind`. A matching record
// is asserted to round-trip kind + a 6-char prefix; non-matching ones
// (whitelist + plain prose) must return `matched: false`.

import { describe, expect, test } from "bun:test";

import {
  detectSecretShape,
  REQUEST_CREDENTIAL_FORM_FALLBACK,
  secretRedirectHint,
} from "./secret-shape.ts";

// 64-char hex blob — used to pad real-shape tokens like `dop_v1_…`.
const HEX64 = "a9053683ac4c864800f693f0c7b325d880a44f056bd884c8d975db2ece655796";
const HEX36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const HEX40 = "abcdefghijklmnopqrstuvwxyz0123456789abcd";

describe("detectSecretShape — positive matches", () => {
  test.each<[string, string, string]>([
    ["digitalocean_pat", `dop_v1_${HEX64}`, "dop_v1"],
    ["github_pat", `ghp_${HEX36}`, "ghp_ab"],
    ["github_oauth", `gho_${HEX36}`, "gho_ab"],
    ["github_user_to_server", `ghu_${HEX36}`, "ghu_ab"],
    ["github_server_to_server", `ghs_${HEX36}`, "ghs_ab"],
    ["gitlab_pat", "glpat-AbCdEfGhIjKlMnOpQrSt", "glpat-"],
    ["anthropic_key", `sk-ant-${HEX40}xxxx`, "sk-ant"],
    ["openai_key", `sk-${HEX40}`, "sk-abc"],
    ["slack_token", "xoxb-1234567890-abcdef-ghi", "xoxb-1"],
    ["slack_token", "xoxp-1234567890-abcdef-ghi", "xoxp-1"],
    ["bearer_token", "Bearer abcdef0123456789abcdef0123456789abcdef", "abcdef"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36", "eyJhbG"],
    ["aws_keypair", "AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AKIAIO"],
  ])("flags %s", (kind, sample, expectedSample) => {
    const result = detectSecretShape(sample);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.kind).toBe(kind);
      expect(result.sample.startsWith(expectedSample)).toBe(true);
      // Sample must NEVER contain the full token. 6 chars + ellipsis = 7.
      expect(result.sample.length).toBeLessThanOrEqual(8);
      // Cross-check: the sample never accidentally leaks the whole token.
      expect(result.sample).not.toBe(sample);
    }
  });

  test("flags a token embedded in a longer pasted message", () => {
    const text = `Here you go boss: dop_v1_${HEX64} please use it carefully.`;
    const result = detectSecretShape(text);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.kind).toBe("digitalocean_pat");
      expect(result.sample.startsWith("dop_v1")).toBe(true);
    }
  });
});

describe("detectSecretShape — negative + whitelist", () => {
  test("empty string returns matched: false", () => {
    expect(detectSecretShape("").matched).toBe(false);
  });

  test("short string returns matched: false fast", () => {
    expect(detectSecretShape("hi").matched).toBe(false);
  });

  test("plain prose without secrets returns matched: false", () => {
    const text =
      "Help me set up a connector for digitalocean please, the API endpoint is documented somewhere.";
    expect(detectSecretShape(text).matched).toBe(false);
  });

  test("UUIDv4 conversation id alone is not flagged", () => {
    // A bare UUID is shorter than every pattern's minimum length, but
    // the whitelist is the load-bearing guarantee for the case where a
    // future pattern might be more permissive.
    expect(detectSecretShape("00b93a52-1234-4abc-9def-0123456789ab").matched).toBe(false);
  });

  test("absolute file path alone is not flagged", () => {
    expect(detectSecretShape("/Users/dev/projects/subkit/apps/engine/src/index.ts").matched).toBe(
      false,
    );
  });

  test("conversation id mentioned mid-sentence is not flagged", () => {
    const text = "Resume conversation 00b93a52-1234-4abc-9def-0123456789ab for me please.";
    expect(detectSecretShape(text).matched).toBe(false);
  });

  test("a short Bearer header (under threshold) is not flagged", () => {
    expect(detectSecretShape("Bearer abc123").matched).toBe(false);
  });
});

describe("secretRedirectHint", () => {
  test("renders the kind label and sample without leaking", () => {
    const hint = secretRedirectHint({ kind: "digitalocean_pat", sample: "dop_v1…" });
    expect(hint).toContain("digitalocean pat");
    expect(hint).toContain("dop_v1…");
    expect(hint).toContain("masked form");
    expect(hint).toContain("Press Enter to confirm");
  });
});

describe("REQUEST_CREDENTIAL_FORM_FALLBACK", () => {
  test("never includes a literal credential", () => {
    expect(REQUEST_CREDENTIAL_FORM_FALLBACK).toContain("ask_user_form");
    expect(REQUEST_CREDENTIAL_FORM_FALLBACK).toContain("password");
    expect(REQUEST_CREDENTIAL_FORM_FALLBACK).not.toMatch(/dop_v1_|sk-ant-|ghp_/);
  });
});
