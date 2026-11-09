import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REDACTED,
  findSecretSpans,
  isAlreadyRedacted,
  isLogSensitiveKey,
  redactSecretShapes,
  redactWithMaxDepth,
  referencesKeyMaterialPath,
  SECRET_PATTERNS,
  scrubSecrets,
  scrubString,
  scrubStringsDeep,
} from "../redaction.ts";

describe("redaction boundary inventory", () => {
  test("code-context detection does not cross a newline", () => {
    const token = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
    const text = `const seed = "safe";\n"${token}"`;
    expect(scrubString(text)).toBe('const seed = "safe";\n"***REDACTED:generic***"');
  });

  test("org/model exemption requires the immediately preceding slash", () => {
    const token = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
    expect(scrubString(`Xenova/${token}`)).toBe(`Xenova/${token}`);
    expect(scrubString(`Xenova-${token}`)).toBe("***REDACTED:generic***");
  });

  test("org/model exemption does not recover a prefix truncated beyond its lookback window", () => {
    const token = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
    const longOrg = "a".repeat(129);
    expect(scrubString(`${longOrg}/${token}`)).toBe(`${longOrg}/***REDACTED:generic***`);
  });

  test("span markers retain their exact offsets and shield embedded shapes", () => {
    const marker = "***REDACTED:pat***";
    const token = `ghp_${"aB1c".repeat(8)}`;
    const text = `${marker} ${token}`;
    expect(findSecretSpans(text)).toEqual([
      { start: marker.length + 1, end: text.length, kind: "pat", match: token },
    ]);
    expect(findSecretSpans(`***REDACTED:pat***${token}`)).toEqual([
      { start: marker.length, end: marker.length + token.length, kind: "pat", match: token },
    ]);
  });

  test("a live secret immediately before a redaction marker still has a span", () => {
    const token = `ghp_${"a".repeat(30)}`;
    const marker = "***REDACTED:generic***";
    expect(findSecretSpans(`${token}${marker}`)).toEqual([
      { start: 0, end: token.length, kind: "pat", match: token },
    ]);
  });

  test("span output is ordered even when the earlier token uses a later pattern", () => {
    const pat = `npm_${"aB1c".repeat(8)}`;
    const aws = "AKIA1234567890ABCDEF";
    expect(findSecretSpans(`${aws} ${pat}`).map((span) => span.kind)).toEqual(["aws_key", "pat"]);
  });

  test("prompt carriers distinguish null, arrays, and strings", () => {
    const prose = "internal instructions";
    expect(scrubSecrets({ prompt: prose, promptNull: null, promptList: [prose] })).toEqual({
      prompt: "***REDACTED:prompt***",
      promptNull: null,
      promptList: "***REDACTED:prompt***",
    });
  });

  test("sensitive keys only replace string values", () => {
    expect(scrubSecrets({ token: 1, password: false, api_key: null })).toEqual({
      token: 1,
      password: false,
      api_key: null,
    });
  });

  test("scrubSecrets preserves an already-redacted prompt and collapses a circular payload", () => {
    const node: Record<string, unknown> = { prompt: "***REDACTED:generic***" };
    node.self = node;
    expect(scrubSecrets(node)).toEqual({ prompt: "***REDACTED:generic***", self: "[circular]" });
  });

  test("prompt carriers never preserve marker-like array coercions", () => {
    expect(scrubSecrets({ prompt: ["***REDACTED:generic***"] })).toEqual({
      prompt: "***REDACTED:prompt***",
    });
  });

  test("array nesting increments depth in every recursive redaction entrypoint", () => {
    let nested: unknown = "safe";
    for (let depth = 0; depth < 17; depth++) nested = [nested];
    expect(JSON.stringify(scrubSecrets(nested))).toContain("[depth-exceeded]");
    expect(JSON.stringify(scrubStringsDeep(nested))).toContain("[depth-exceeded]");
    expect(JSON.stringify(redactWithMaxDepth(nested, 16))).toContain("[depth-exceeded]");
  });

  test("object recursion contributes to scrubStringsDeep depth", () => {
    let nested: unknown = "safe";
    for (let depth = 0; depth < 17; depth++) nested = { nested };
    expect(JSON.stringify(scrubStringsDeep(nested))).toContain("[depth-exceeded]");
  });

  test("logger array recursion observes a caller max depth below the scrubber limit", () => {
    expect(redactWithMaxDepth([["safe"]], 1)).toEqual(["[depth-exceeded]"]);
  });

  test("logger depth limit is inclusive and respects its starting depth", () => {
    expect(redactWithMaxDepth("safe", 0)).toBe("[depth-exceeded]");
    expect(redactWithMaxDepth({ child: "safe" }, 1)).toEqual({ child: "[depth-exceeded]" });
  });

  test("key-material paths require bounded secret filenames", () => {
    const positives = [
      "read /keys/deploy.key",
      "read /keys/cert.pem",
      "read .env.local",
      "read $HOME/.gnupg/pubring.kbx",
      "read id_rsa",
      "read /etc/service/client-secret.json",
      "read /etc/service/key",
      "read /run/secrets/db",
      "read /.aws/credentials",
      "read /.docker/config.json",
      "read /.netrc",
      "read /.pgpass",
      "read /KEYS/DEPLOY.KEY",
      "read /KEYS/CERT.PEM",
      "read /CONFIG/.ENV.LOCAL",
      "read .ssh/id_rsa",
      "read /.ssh/config",
    ];
    for (const path of positives) expect(referencesKeyMaterialPath(path)).toBe(true);
    for (const path of [
      "deploy.keychain",
      "cert.pemfile",
      ".envx",
      "id_rsa_old",
      "/run/secretsx",
      "$foo/key.key",
      "$foo/cert.pem",
    ]) {
      expect(referencesKeyMaterialPath(path)).toBe(false);
    }
  });
  test("case and camel-case normalization keep logger keys sensitive", () => {
    expect(isLogSensitiveKey("DATABASE_URL")).toBe(true);
    expect(isLogSensitiveKey("databaseUrl")).toBe(true);
    expect(isLogSensitiveKey("Authorization")).toBe(true);
    expect(isLogSensitiveKey("notSensitive")).toBe(false);
    expect(isLogSensitiveKey("toKen")).toBe(true);
    expect(isLogSensitiveKey("passWord")).toBe(true);
    expect(isLogSensitiveKey("apiKEY")).toBe(true);
  });

  test("exported secret patterns cannot leak their lastIndex into span detection", () => {
    const token = `ghp_${"aB1c".repeat(8)}`;
    const pattern = SECRET_PATTERNS.find(({ regex }) => regex.source.includes("ghp_"))!.regex;
    pattern.test(`prefix ${token}`);
    expect(findSecretSpans(token)).toEqual([
      { start: 0, end: token.length, kind: "pat", match: token },
    ]);
    expect(pattern.lastIndex).toBe(0);
  });

  test("bearer shape accepts all whitespace and dotted credentials", () => {
    const spaced = "Bearer\t abc.def-123456";
    expect(scrubString(spaced)).toBe("***REDACTED:bearer***");
    expect(findSecretSpans(spaced)).toEqual([
      { start: 0, end: spaced.length, kind: "bearer", match: spaced },
    ]);
  });

  test("bearer shape permits a dot as the credential proof even without digits", () => {
    const dottedOnly = "Bearer abcdefg.hijklmnop";
    expect(scrubString(dottedOnly)).toBe("***REDACTED:bearer***");
    expect(findSecretSpans(dottedOnly)).toEqual([
      { start: 0, end: dottedOnly.length, kind: "bearer", match: dottedOnly },
    ]);
  });

  test("code-literal exception is confined to the immediate quoted value", () => {
    const token = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
    expect(scrubString(`const seed="${token}"`)).toContain(token);
    expect(scrubString(`const seed="safe ${token}"`)).not.toContain(token);
    expect(scrubString(`const api_key="${token}"`)).not.toContain(token);
  });

  test("code-literal exception tolerates comments around the assignment only", () => {
    const token = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
    expect(scrubString(`const seed = /* generated */ "${token}"`)).toContain(token);
    expect(scrubString(`const seed = /* generated */ "safe ${token}"`)).not.toContain(token);
  });

  test("logger scrubbers replace complete credential spans without retaining a suffix", () => {
    const text = [
      "Bearer abc.def-123456",
      "v0=0123456789abcdef",
      "wf_test_Abc123",
      "postgres://alice:secret@db.example/tenant",
    ].join(" | ");
    expect(redactWithMaxDepth({ text }, 4)).toEqual({
      text: [
        DEFAULT_REDACTED,
        DEFAULT_REDACTED,
        DEFAULT_REDACTED,
        `${DEFAULT_REDACTED}db.example/tenant`,
      ].join(" | "),
    });
  });

  test("sensitive-key shape matching covers optional separators and does not rely on logger key names", () => {
    expect(
      scrubSecrets({ apikey: "a", "api-key": "b", credentialValue: "c", authorizationHeader: "d" }),
    ).toEqual({
      apikey: "***REDACTED:key_value***",
      "api-key": "***REDACTED:key_value***",
      credentialValue: "***REDACTED:key_value***",
      authorizationHeader: "***REDACTED:key_value***",
    });
  });

  test("logger bearer scrubbing accepts repeated whitespace while secret bearer matching rejects prose", () => {
    expect(redactWithMaxDepth("Bearer  abc.def-123456", 2)).toBe(DEFAULT_REDACTED);
    expect(scrubString("Bearer abcdefghijklmnopqrstuvwxyz")).toBe(
      "Bearer abcdefghijklmnopqrstuvwxyz",
    );
  });

  test("token families use their declared marker for the entire matching value", () => {
    const samples: Array<[string, string]> = [
      [`dop_v1_${"aB1c".repeat(9)}`, "pat"],
      [`ghp_${"aB1c".repeat(8)}`, "pat"],
      [`gho_${"aB1c".repeat(8)}`, "pat"],
      [`ghu_${"aB1c".repeat(8)}`, "pat"],
      [`ghs_${"aB1c".repeat(8)}`, "pat"],
      [`glpat-${"aB1c".repeat(6)}`, "pat"],
      [`sk-ant-${"aB1c".repeat(6)}`, "pat"],
      [`ATATT${"aB1c".repeat(6)}`, "pat"],
      [`sk_live_${"aB1c".repeat(5)}`, "pat"],
      [`rk_test_${"aB1c".repeat(5)}`, "pat"],
      [`sk-${"aB1c".repeat(6)}`, "pat"],
      [`xoxb-${"aB1c-".repeat(5)}`, "pat"],
      [`xoxp-${"aB1c-".repeat(5)}`, "pat"],
      [`npm_${"aB1c".repeat(8)}`, "pat"],
      ["AKIA1234567890ABCDEF", "aws_key"],
      ["eyJabc.def-123.ghi_456", "jwt"],
      ["Bearer abc123def456ghi789jkl0", "bearer"],
    ];
    for (const [token, kind] of samples) {
      expect(redactSecretShapes(`before ${token} after`)).toEqual({
        text: `before ***REDACTED:${kind}*** after`,
        count: 1,
      });
    }
  });

  test("generic entropy detection distinguishes one digit from two and respects code context", () => {
    const twoDigits = "Ab1Cd2EfGhIjKlMnOpQrStUvWxYzabcdef";
    const oneDigit = "Ab1CdEfGhIjKlMnOpQrStUvWxYzabcdefg";
    expect(scrubString(twoDigits)).toBe("***REDACTED:generic***");
    expect(scrubString(oneDigit)).toBe(oneDigit);
    expect(scrubString(`const /* type */ ordinary /* assigned */ = "${twoDigits}`)).toContain(
      twoDigits,
    );
    expect(scrubString(`const /* type */ authToken /* assigned */ = "${twoDigits}`)).not.toContain(
      twoDigits,
    );
    const lowercaseLead = "aB1Cd2EfGhIjKlMnOpQrStUvWxYzabcdef";
    expect(scrubString(lowercaseLead)).toBe("***REDACTED:generic***");
  });

  test("recognized codec alphabets remain visible across each supported encoding", () => {
    for (const alphabet of [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      "0123456789abcdefghijklmnopqrstuvwxyz",
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ])
      expect(scrubString(alphabet)).toBe(alphabet);
  });

  test("previous markers do not prevent a following live secret from being scrubbed", () => {
    const token = `ghp_${"aB1c".repeat(8)}`;
    expect(scrubString(`***REDACTED:pat*** then ${token}`)).toBe(
      "***REDACTED:pat*** then ***REDACTED:pat***",
    );
  });

  test("presentable grants stay visible in shape redaction as well as string redaction", () => {
    const grant = "skog_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    expect(redactSecretShapes(grant)).toEqual({ text: grant, count: 0 });
  });

  test("shape redaction preserves a presentable grant when an exported pattern is extended at runtime", () => {
    const grant = "skog_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    const pattern = SECRET_PATTERNS[0]!.regex;
    const source = pattern.source;
    const flags = pattern.flags;
    try {
      pattern.compile(/\bskog_[A-Za-z0-9_-]{20,}/.source, "g");
      expect(redactSecretShapes(grant)).toEqual({ text: grant, count: 0 });
      expect(findSecretSpans(grant)).toEqual([]);
    } finally {
      pattern.compile(source, flags);
      pattern.lastIndex = 0;
    }
  });

  test("marker ranges protect against an exported pattern compiled to their inner text", () => {
    const marker = "***REDACTED:generic***";
    const pattern = SECRET_PATTERNS[0]!.regex;
    const source = pattern.source;
    const flags = pattern.flags;
    try {
      pattern.compile(/REDACTED:generic/.source, "g");
      expect(findSecretSpans(marker)).toEqual([]);
    } finally {
      pattern.compile(source, flags);
      pattern.lastIndex = 0;
    }
  });

  test("only a complete OAuth grant is presentable", () => {
    const grant = "skog_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    const prefixed = `X${grant}`;
    expect(scrubString(prefixed)).not.toContain(prefixed);
    expect(findSecretSpans(prefixed)).toHaveLength(1);
  });

  test("a grant-shaped generic token with an equals suffix is not presentable", () => {
    const grant = `skog_${"aA12bB34".repeat(6)}=x`;
    expect(scrubString(grant)).toBe("***REDACTED:generic***");
    expect(findSecretSpans(grant)).toEqual([
      { start: 0, end: grant.length, kind: "generic", match: grant },
    ]);
  });

  test("findSecretSpans resolves a vendor-pattern overlap once and keeps sorted exact spans", () => {
    const overlapping = "sk_live_Ab1cAb1cAb1cAb1cAb1c";
    const later = "ghp_Ab1cAb1cAb1cAb1cAb1cAb1cAb1cAb1c";
    const text = `${later} ${overlapping}`;
    expect(findSecretSpans(text)).toEqual([
      { start: 0, end: later.length, kind: "pat", match: later },
      { start: later.length + 1, end: text.length, kind: "pat", match: overlapping },
    ]);
  });

  test("recursive scrubbers preserve primitives, traverse arrays, and stop precisely at depth sixteen", () => {
    const token = `ghp_${"aB1c".repeat(8)}`;
    expect(scrubSecrets(undefined)).toBeUndefined();
    expect(scrubSecrets(null)).toBeNull();
    expect(scrubSecrets(0)).toBe(0);
    expect(scrubSecrets([token])).toEqual(["***REDACTED:pat***"]);
    expect(scrubStringsDeep([token])).toEqual(["***REDACTED:pat***"]);
    let beyondLimit: unknown = token;
    for (let depth = 0; depth < 17; depth++) beyondLimit = { nested: beyondLimit };
    let atLimit: unknown = token;
    for (let depth = 0; depth < 16; depth++) atLimit = { nested: atLimit };
    expect(JSON.stringify(scrubSecrets(beyondLimit))).toContain("[depth-exceeded]");
    expect(JSON.stringify(scrubSecrets(atLimit))).toContain("***REDACTED:pat***");
  });

  test("logger depth and key boundaries preserve safe values while suppressing sensitive branches", () => {
    expect(redactWithMaxDepth(null, 2)).toBeNull();
    expect(redactWithMaxDepth(42, 2)).toBe(42);
    expect(redactWithMaxDepth("Bearer abc.def-123456", 2)).toBe(DEFAULT_REDACTED);
    expect(redactWithMaxDepth({ safe: "ok", token: "raw" }, 2)).toEqual({
      safe: "ok",
      token: DEFAULT_REDACTED,
    });
    expect(redactWithMaxDepth({ nested: { value: "ok" } }, 1)).toEqual({
      nested: "[depth-exceeded]",
    });
  });

  test("logger-sensitive keys redact every declared spelling and preserve neighboring names", () => {
    const sensitive = [
      "password",
      "secret",
      "token",
      "api_key",
      "apikey",
      "authorization",
      "cookie",
      "set-cookie",
      "master_key",
      "bot_token",
      "client_secret",
      "signing_secret",
      "service_account_json",
      "private_key",
      "slack_signing_secret",
      "slack_bot_token",
      "teams_app_password",
      "teams_client_secret",
      "google_service_account",
      "google_service_account_json",
      "google_credentials_json",
      "refresh_token",
      "access_token",
      "id_token",
      "session_token",
      "secret_key",
      "secret_access_key",
      "aws_secret_access_key",
      "passphrase",
      "webhook_secret",
      "client_assertion",
      "database_url",
      "connection_string",
      "connectionstring",
    ];
    const payload = Object.fromEntries(sensitive.map((key) => [key, "raw-value"]));
    const out = redactWithMaxDepth(payload, 4) as Record<string, unknown>;
    for (const key of sensitive) {
      expect(isLogSensitiveKey(key)).toBe(true);
      expect(out[key]).toBe(DEFAULT_REDACTED);
    }
    expect(isLogSensitiveKey("tokenizer")).toBe(false);
    expect(isLogSensitiveKey("databaseUrl")).toBe(true);
    expect(isLogSensitiveKey("session-id")).toBe(false);
  });

  test("logger string scrubbers remove bearer, signature, workflow and postgres credentials", () => {
    const text = [
      "Bearer abc.def-123456",
      "v0=0123456789abcdef",
      "wf_live_Abc123",
      "postgresql://alice:secret@db.example/tenant",
    ].join(" | ");
    const out = redactWithMaxDepth({ text }, 4) as { text: string };
    expect(out.text).not.toContain("abc.def-123456");
    expect(out.text).not.toContain("0123456789abcdef");
    expect(out.text).not.toContain("wf_live_Abc123");
    expect(out.text).not.toContain("alice:secret@");
    expect(out.text.match(/\*\*\*redacted\*\*\*/g)).toHaveLength(4);
  });

  test("every declared token family redacts a valid boundary-shaped value", () => {
    const samples = [
      `dop_v1_${"aB1c".repeat(9)}`,
      `ghp_${"aB1c".repeat(8)}`,
      `gho_${"aB1c".repeat(8)}`,
      `ghu_${"aB1c".repeat(8)}`,
      `ghs_${"aB1c".repeat(8)}`,
      `glpat-${"aB1c".repeat(6)}`,
      `sk-ant-${"aB1c".repeat(6)}`,
      `ATATT${"aB1c".repeat(6)}`,
      `sk_live_${"aB1c".repeat(5)}`,
      `rk_test_${"aB1c".repeat(5)}`,
      `sk-${"aB1c".repeat(6)}`,
      `xoxb-${"aB1c-".repeat(5)}`,
      `xoxp-${"aB1c-".repeat(5)}`,
      `npm_${"aB1c".repeat(8)}`,
      "AKIA1234567890ABCDEF",
      "eyJabc.def-123.ghi_456",
      "Bearer abc123def456ghi789jkl0",
    ];
    for (const token of samples) {
      const out = redactSecretShapes(`before ${token} after`);
      expect(out.text).not.toContain(token);
      expect(out.count).toBeGreaterThan(0);
    }
  });

  test("generic-token boundaries require lower, upper, two digits and thirty-two characters", () => {
    const token = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
    expect(scrubString(token)).toBe("***REDACTED:generic***");
    for (const near of [
      token.slice(0, 31),
      "ab1cd2ef3gh4ij5kl6mn7op8qr9st0uv",
      "AB1CD2EF3GH4IJ5KL6MN7OP8QR9ST0UV",
      "AbcDefGhIjKlMnOpQrStUvWxYzabcdef",
    ])
      expect(scrubString(near)).toBe(near);
  });

  test("code-context exemptions distinguish neutral identifiers from secret identifiers", () => {
    const token = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
    expect(scrubString(`let /* note */ seed /* x */ = "${token}"`)).toContain(token);
    expect(scrubString(`let bearer = "${token}"`)).not.toContain(token);
    expect(scrubString(`let key = "${token}"`)).not.toContain(token);
  });

  test("presign URLs cover both cloud families and signature spellings without touching ordinary queries", () => {
    const signed = [
      "https://bucket.test/a?X-Amz-Algorithm=AWS4&x=1",
      "http://bucket.test/a?X-Amz-Credential=abc&x=1",
      "https://bucket.test/a?X-Goog-Algorithm=GOOG4&x=1",
      "https://bucket.test/a?X-Goog-Signature=abc&x=1",
      "https://bucket.test/a?Signature=abc&x=1",
    ];
    for (const url of signed) expect(scrubString(url)).toMatch(/\?<presign-redacted>$/);
    expect(scrubString("https://bucket.test/a?part=one&X-Amz-Signature=abc")).toBe(
      "https://bucket.test/a?<presign-redacted>",
    );
    expect(scrubString("https://bucket.test/a?download=1")).toBe(
      "https://bucket.test/a?download=1",
    );
  });

  test("redaction markers are exact whole values and never become secret spans", () => {
    for (const marker of ["***redacted***", "***REDACTED:pat***", "***ReDaCtEd:generic***"])
      expect(isAlreadyRedacted(marker)).toBe(true);
    for (const value of ["x***redacted***", "***redacted***x", "***redacted:bad!***"])
      expect(isAlreadyRedacted(value)).toBe(false);
    expect(findSecretSpans("***REDACTED:pat*** ghp_aB1caB1caB1caB1caB1caB1caB1caB1c")).toHaveLength(
      1,
    );
  });

  test("depth boundaries and primitive values retain their contract", () => {
    let nested: unknown = "safe";
    for (let depth = 0; depth < 17; depth++) nested = { nested };
    expect(JSON.stringify(scrubSecrets(nested))).toContain("[depth-exceeded]");
    expect(scrubStringsDeep(undefined)).toBeUndefined();
    expect(scrubStringsDeep(null)).toBeNull();
    expect(scrubStringsDeep(42)).toBe(42);
  });

  test("key-material path patterns reject close non-secret names", () => {
    const paths = [
      "read ./certs/service.key",
      "read /srv/client/cert.pem",
      "read .env.production",
      "read $HOME/.gnupg/pubring.kbx",
      "read id_rsa",
      "read /etc/app/credential-store",
      "read /.aws/credentials",
      "read /.docker/config.json",
      "read /.netrc",
      "read /.pgpass",
    ];
    for (const path of paths) expect(referencesKeyMaterialPath(path)).toBe(true);
    for (const path of [
      "/tmp/a.key",
      "/tmp/cert.p12",
      "/srv/.env.local",
      "/home/alice/.ssh/config",
      "/home/alice/.gnupg/pubring.kbx",
      "/etc/app/nested/service-secret.json",
      "/run/secrets",
      "/.aws/credentials",
      "/.docker/config.json",
      "/.netrc",
      "/.pgpass",
    ])
      expect(referencesKeyMaterialPath(path)).toBe(true);
    for (const path of ["id_rsa_notes", "/srv/keynote.txt", ".envx", "/tmp/public.pemx"])
      expect(referencesKeyMaterialPath(path)).toBe(false);
  });
});
