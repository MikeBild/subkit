import { describe, expect, test } from "bun:test";
import { findSecretSpans, scrubSecrets, scrubString, scrubStringsDeep } from "../redaction.ts";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const SHA256_HEX = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const HEX_64_UPPER = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";

describe("scrubString — code literals that MUST pass through unchanged", () => {
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

const HIGH_ENTROPY_TOKEN = "Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRsTuVwXyZ1";

describe("scrubString — true secrets STILL redacted", () => {
  test("'Authorization: Bearer sk-live-<20 chars>' → redacts the token (pat pattern)", () => {
    const raw = "Authorization: Bearer sk-live-abc123def456ghi789j";
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:");
    expect(out).not.toContain("sk-live-");
  });

  test("'api_key=<high-entropy>' → generic redacts the value (in-band keyword prefix)", () => {
    const raw = `api_key=${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
  });

  test("URL '?signature=<high-entropy>' → scrubber removes the token (either presign or generic path)", () => {
    const raw = `https://api.example.com/hook?signature=${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
    const sanitized = out.includes("<presign-redacted>") || out.includes("***REDACTED");
    expect(sanitized).toBe(true);
  });

  test("URL '?sig=<high-entropy>' (short param name) → generic redacts", () => {
    const raw = `https://x.test/y?sig=${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(HIGH_ENTROPY_TOKEN);
  });

  test("'authorization: Bearer <high-entropy>' header → generic redacts (lookback window)", () => {
    const raw = `authorization: Bearer ${HIGH_ENTROPY_TOKEN}`;
    const out = scrubString(raw);
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

describe("scrubString — boundary: keyword-anchored base64 alphabet value", () => {
  test("when the full alphabet IS the api_key value, it IS redacted (keyword present)", () => {
    const raw = `api_key=${BASE64_ALPHABET}`;
    const out = scrubString(raw);
    expect(out).toContain("***REDACTED:generic***");
  });

  test("a bare const-assigned base64 alphabet WITHOUT a keyword is NOT redacted", () => {
    const code = `var B="${BASE64_ALPHABET}";let o="";return o;`;
    expect(scrubString(code)).toBe(code);
  });
});

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

describe("scrubString — credential-named variables still redact in code context", () => {
  for (const name of ["bearer", "jwt", "pat", "key", "session", "cookie", "signature", "sig"]) {
    test(`const ${name} = "<hi-entropy>" IS redacted (credential var name)`, () => {
      const code = `const ${name} = "${BARE_VENDORLESS_TOKEN}";`;
      const out = scrubString(code);
      expect(out).toContain("***REDACTED:generic***");
      expect(out).not.toContain(BARE_VENDORLESS_TOKEN);
    });
  }

  test('const data = "<hi-entropy>" is NOT redacted (neutral name, code context)', () => {
    const code = `const data = "${BARE_VENDORLESS_TOKEN}";`;
    expect(scrubString(code)).toBe(code);
  });

  test('const raw = "<base64url alphabet>" survives verbatim (neutral name)', () => {
    const code = `const raw = "${BASE64_URL_SAFE}";`;
    expect(scrubString(code)).toBe(code);
  });

  test('const data = "<base64 alphabet>" survives verbatim (neutral name)', () => {
    const code = `const data = "${BASE64_ALPHABET}";`;
    expect(scrubString(code)).toBe(code);
  });

  test('const data = "ghp_<...>" IS redacted (vendor prefix beats neutral name)', () => {
    const vendorToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const code = `const data = "${vendorToken}";`;
    const out = scrubString(code);
    expect(out).toContain("***REDACTED:");
    expect(out).not.toContain(vendorToken);
  });
});

describe("scrubString — long inline comment before a codec literal", () => {
  test('var /* long comment */ B = "<alphabet>" is NOT redacted', () => {
    const longComment = `/* ${"x".repeat(120)} */`;
    const code = `var ${longComment} B = "${BASE64_ALPHABET}";`;
    expect(scrubString(code)).toBe(code);
  });

  test("a credential-named var with a long inline comment STILL redacts", () => {
    const longComment = `/* ${"y".repeat(120)} */`;
    const code = `var ${longComment} apiKey = "${BARE_VENDORLESS_TOKEN}";`;
    const out = scrubString(code);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(BARE_VENDORLESS_TOKEN);
  });
});

describe("scrubString — code-context lookback boundary (256-char window)", () => {
  const FRAMING = "var ".length + "/* ".length + " */ ".length + 'x = "'.length;
  const lineWithPrefixLen = (prefixLen: number, token: string): string => {
    const fillerLen = prefixLen - FRAMING;
    return `var /* ${"z".repeat(fillerLen)} */ x = "${token}";`;
  };

  for (const prefixLen of [254, 255, 256]) {
    test(`prefix length ${prefixLen} (<=256): the literal survives`, () => {
      const code = lineWithPrefixLen(prefixLen, BARE_VENDORLESS_TOKEN);
      expect(scrubString(code)).toBe(code);
    });
  }

  test("prefix length 257 (>256): the lookback can no longer see `var`, so it redacts", () => {
    const code = lineWithPrefixLen(257, BARE_VENDORLESS_TOKEN);
    const out = scrubString(code);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(BARE_VENDORLESS_TOKEN);
  });
});
