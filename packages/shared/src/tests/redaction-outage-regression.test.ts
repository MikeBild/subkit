// Regression tests for the redaction outage — the "generic" high-entropy
// matcher was flagging code literals (the bare base64 alphabet, SHA-256 hex
// strings, plain hex digests) and corrupting authored workflow definitions.
//
// The code-context-suppressed fix must leave code-literal shapes (codec
// alphabets, non-secret `var/const/let = "..."` literals) UNCHANGED while
// still redacting true secrets — including a BARE vendor-less token with no
// keyword (the lone-paste / `here you go: <token>` shape), which the
// matcher catches on shape alone.
//
// All fake tokens are shaped to match the regex patterns, never real entropy.

import { describe, expect, test } from "bun:test";
import { findSecretSpans, scrubSecrets, scrubString, scrubStringsDeep } from "../redaction.ts";

// ---------------------------------------------------------------------------
// The bare base64 alphabet — the exact literal that caused the outage.
// A pasted workflow definition containing the 64-char standard alphabet was
// redacted to "***REDACTED:generic***", the inner authoring LLM saved
// `var B="***REDACTED:generic***/"`; the hand-rolled encoder emitted
// "undefined" 43,923x; a 416KB corrupt Gmail body hung send for ~5min.
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// A real sha-256 hex digest — 64 lowercase hex chars. Satisfies neither the
// mixed-case nor the two-digit lookahead in GENERIC_TOKEN_RE (no uppercase),
// so it must pass through verbatim.
const SHA256_HEX = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

// A 64-char hex string (uppercase+digits only — no lowercase in the run,
// failing the mixed-case lookahead). Must pass through verbatim.
const HEX_64_UPPER = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";

describe("scrubString — code literals that MUST pass through unchanged (outage regression)", () => {
  test("bare base64 standard alphabet is NOT redacted", () => {
    expect(scrubString(BASE64_ALPHABET)).toBe(BASE64_ALPHABET);
  });

  test("bare base64 url-safe alphabet is NOT redacted", () => {
    expect(scrubString(BASE64_URL_SAFE)).toBe(BASE64_URL_SAFE);
  });

  test("base64 alphabet embedded in a JS const declaration is NOT redacted", () => {
    const code = `const B="${BASE64_ALPHABET}";`;
    expect(scrubString(code)).toBe(code);
  });

  test("sha256-shaped 64-char lowercase hex is NOT redacted", () => {
    const text = `digest: ${SHA256_HEX}`;
    expect(scrubString(text)).toBe(text);
  });

  test("64-char uppercase hex digest is NOT redacted", () => {
    // No `key=` prefix: an uppercase-only hex run carries no lowercase, so
    // it fails the mixed-case lookahead and never matches. (A `hash=`-glued
    // prefix would lend its own lowercase to the run and is a different,
    // genuinely-ambiguous high-entropy shape — not asserted here.)
    const text = `digest ${HEX_64_UPPER} stored`;
    expect(scrubString(text)).toBe(text);
  });

  test("scrubStringsDeep leaves the base64 alphabet intact at any depth", () => {
    expect(scrubStringsDeep(BASE64_ALPHABET)).toBe(BASE64_ALPHABET);
    expect(scrubStringsDeep({ codec: { alphabet: BASE64_ALPHABET } })).toEqual({
      codec: { alphabet: BASE64_ALPHABET },
    });
  });

  test("findSecretSpans reports zero spans for the bare base64 alphabet", () => {
    expect(findSecretSpans(BASE64_ALPHABET)).toHaveLength(0);
    expect(findSecretSpans(BASE64_URL_SAFE)).toHaveLength(0);
  });

  test("findSecretSpans reports zero spans for a sha256 hex digest", () => {
    expect(findSecretSpans(SHA256_HEX)).toHaveLength(0);
    expect(findSecretSpans(HEX_64_UPPER)).toHaveLength(0);
  });

  test("scrubSecrets leaves the base64 alphabet intact inside an object", () => {
    const obj = { codec_table: BASE64_ALPHABET, description: "base64 standard alphabet" };
    expect((scrubSecrets(obj) as typeof obj).codec_table).toBe(BASE64_ALPHABET);
  });
});

// ---------------------------------------------------------------------------
// True secrets that MUST still be redacted after the fix.
// ---------------------------------------------------------------------------

// A 40-char mixed-case+2-digit high-entropy run — the same shape GENERIC_BLOB
// uses in the main test file. Must redact when preceded by a keyword/header.
const HIGH_ENTROPY_TOKEN = "Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRsTuVwXyZ1";

describe("scrubString — true secrets STILL redacted after outage fix", () => {
  test("'Authorization: Bearer sk-live-<20 chars>' → redacts the token (pat pattern)", () => {
    const raw = "Authorization: Bearer sk-live-abc123def456ghi789j";
    const out = scrubString(raw);
    // The `sk-[A-Za-z0-9]{20,}` pat fires on the sk-live-… run.
    expect(out).toContain("***REDACTED:");
    expect(out).not.toContain("sk-live-");
  });

  test("'api_key=<high-entropy>' → generic redacts the value (in-band keyword prefix)", () => {
    // The in-band prefix detector catches `api_key=` at the start of the
    // matched run — the keyword is glued to the value by `=` which is in
    // the token charset, so the whole run is `api_key=VALUE`.
    const raw = `api_key=${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
  });

  test("URL '?signature=<high-entropy>' → scrubber removes the token (either presign or generic path)", () => {
    // scrubPresignUrls replaces the whole query with '?<presign-redacted>'
    // when the URL matches its PRESIGN_QUERY_RE (covers `[Ss]ignature=`).
    // The generic matcher would also catch this, but the presign pass runs
    // first and removes the query string entirely. Either way, the
    // HIGH_ENTROPY_TOKEN must not appear in the output.
    const raw = `https://api.example.com/hook?signature=${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
    // Presign or generic — one of the two passes must fire.
    const sanitized = out.includes("<presign-redacted>") || out.includes("***REDACTED");
    expect(sanitized).toBe(true);
  });

  test("URL '?sig=<high-entropy>' (short param name) → generic redacts", () => {
    // `?sig=` is NOT in the presign URL pattern (requires X-Amz-Signature etc.
    // or the full `signature=`), so the generic matcher handles it.
    const raw = `https://x.test/y?sig=${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
  });

  test("'authorization: Bearer <high-entropy>' header → generic redacts (lookback window)", () => {
    // The lookback window detects `authorization: Bearer ` before the run.
    const raw = `authorization: Bearer ${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    // Bearer pattern catches if ≥8 token chars; generic picks up the rest.
    expect(out).toContain("***REDACTED:");
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
  });

  test("'api-key: <high-entropy>' → generic redacts (lookback window)", () => {
    const raw = `api-key: ${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
  });

  test("findSecretSpans reports a span for api_key=<high-entropy>", () => {
    const raw = `api_key=${HIGH_ENTROPY_TOKEN}`;
    const spans = findSecretSpans(raw);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0]?.kind).toBe("generic");
  });

  test("findSecretSpans reports zero spans for base64 alphabet even after fix", () => {
    expect(findSecretSpans(BASE64_ALPHABET)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary: the base64 alphabet AS THE VALUE of api_key assignment.
// The outage was exactly this shape: the alphabet appeared as the value
// assigned to a variable. The fix suppresses generic redaction only in CODE
// context — a codec alphabet, or a non-secret `var/const/let = "..."`
// literal. A keyword-anchored value (`api_key=…`) is NOT code context, so it
// still redacts; the hand-rolled encoder's `var B="…"` literal survives.
// ---------------------------------------------------------------------------

describe("scrubString — boundary: keyword-anchored base64 alphabet value", () => {
  test("when the full alphabet IS the api_key value, it IS redacted (keyword present)", () => {
    // A secret credential whose value happens to BE the standard alphabet
    // is unusual but possible in a test fixture or a misconfigured secret
    // store. The in-band `api_key=` keyword prefix means this is not bare
    // codec source, so redaction fires.
    const raw = `api_key=${BASE64_ALPHABET}`;
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:generic***");
  });

  test("a bare const-assigned base64 alphabet WITHOUT a keyword is NOT redacted", () => {
    // This is the outage shape: a non-secret variable name and a codec
    // alphabet value — code context, suppressed.
    const code = `var B="${BASE64_ALPHABET}";let o="";return o;`;
    expect(scrubString(code)).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// The MISSING DIRECTION: a bare vendor-less high-entropy token with NO
// keyword and NO code framing — the lone-paste / `here you go: <token>`
// shape — must STILL redact. This is the secret class the code-context fix
// must not reopen. These assert shape-only detection survives.
// ---------------------------------------------------------------------------

// 40-char mixed-case + 2-digit run; no vendor prefix, no keyword.
const BARE_VENDORLESS_TOKEN = "Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRsTuVwXyZ1";

describe("scrubString — bare vendor-less secrets STILL redact (shape only)", () => {
  test("a lone bare token (no keyword, no prefix) is redacted", () => {
    const out = scrubString(BARE_VENDORLESS_TOKEN);
    expect(out).toBe("***REDACTED:generic***");
    expect(out).not.toContain(BARE_VENDORLESS_TOKEN);
  });

  test("prose-embedded `here you go: <token>` is redacted", () => {
    const raw = `here you go: ${BARE_VENDORLESS_TOKEN}`;
    const out = scrubString(raw);
    expect(out).toBe("here you go: ***REDACTED:generic***");
    expect(out).not.toContain(BARE_VENDORLESS_TOKEN);
  });

  test("findSecretSpans reports a generic span for a bare vendor-less token", () => {
    const spans = findSecretSpans(`here you go: ${BARE_VENDORLESS_TOKEN}`);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe("generic");
  });

  test("a SECRET-named var holding a bare token IS redacted (credential in source)", () => {
    const out = scrubString(`const apiSecret = "${BARE_VENDORLESS_TOKEN}";`);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(BARE_VENDORLESS_TOKEN);
  });

  test("a NON-secret var holding a bare token is NOT redacted (code context)", () => {
    const code = `const seed = "${BARE_VENDORLESS_TOKEN}";`;
    expect(scrubString(code)).toBe(code);
  });
});
