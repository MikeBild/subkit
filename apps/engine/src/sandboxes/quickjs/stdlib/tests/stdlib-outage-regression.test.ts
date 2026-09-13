// Stdlib regression tests for the Gmail send outage (v7.5).
//
// The fix ships deterministic encoding primitives (sk.base64UrlEncode,
// sk.hexEncode, sk.sha256, sk.hmacSha256, sk.uuid, sk.now) as QuickJS
// sandbox globals. These tests pin the "same input → same output"
// invariant for each primitive across separate sandbox invocations —
// the core guarantee that prevents an alphabet-corruption regression from
// occurring through the stdlib path.
//
// Additional coverage:
// - hexEncode/hexDecode round-trip for the outage-relevant byte sequences
//   (the base64 alphabet bytes specifically).
// - sha256/hmacSha256 known-vector spot checks so a stdlib impl swap is
//   caught immediately.
// - uuid/now determinism under a fixed clock seed.

import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { runJs } from "../../runtime.ts";

const run = <T>(code: string, input: unknown = {}) =>
  runJs<T>({ code, input, clock: null }).then((r) => r.output);

const runWithClock = <T>(code: string, clock: { now_ms: number; seed: string }) =>
  runJs<T>({ code, input: {}, clock }).then((r) => r.output);

// ---------------------------------------------------------------------------
// sk.hexEncode / sk.hexDecode — round-trip over the outage-relevant inputs.
// The base64 alphabet bytes are the exact bytes the Gmail MIME body encoder
// was processing when it received a corrupted alphabet and emitted "undefined"
// 43,923 times. Verify the stdlib path produces a well-formed hex string.
// ---------------------------------------------------------------------------

describe("sk.hexEncode / sk.hexDecode — round-trip (stdlib)", () => {
  const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  test("hexEncode over the base64 alphabet bytes produces a valid 128-char lowercase hex string", async () => {
    const encoded = await run<string>("return sk.hexEncode(input.s);", {
      s: BASE64_ALPHABET,
    });
    // 64 chars × 2 hex digits each = 128 chars
    expect(encoded).toHaveLength(128);
    expect(/^[0-9a-f]+$/.test(encoded)).toBe(true);
    expect(encoded).toBe(Buffer.from(BASE64_ALPHABET, "binary").toString("hex"));
  });

  test("hexDecode(hexEncode(base64_alphabet)) round-trips byte-identical", async () => {
    const rt = await run<string>("return sk.hexDecode(sk.hexEncode(input.s));", {
      s: BASE64_ALPHABET,
    });
    expect(rt).toBe(BASE64_ALPHABET);
  });

  test("hexEncode is deterministic: same input → identical output on separate invocations", async () => {
    const a = await run<string>("return sk.hexEncode(input.s);", { s: "hello world" });
    const b = await run<string>("return sk.hexEncode(input.s);", { s: "hello world" });
    expect(a).toBe(b);
    expect(a).toBe(Buffer.from("hello world", "binary").toString("hex"));
  });

  test("hexDecode is deterministic: same hex → same string on separate invocations", async () => {
    const a = await run<string>("return sk.hexDecode('68656c6c6f');", {});
    const b = await run<string>("return sk.hexDecode('68656c6c6f');", {});
    expect(a).toBe("hello");
    expect(b).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// sk.sha256 — round-trip + determinism across invocations + known vectors.
// A sha256-shaped 64-char hex output from the same input must be byte-identical
// on every invocation; this is the property that makes HMAC signatures
// reproducible under self-healing dry-runs.
// ---------------------------------------------------------------------------

describe("sk.sha256 — determinism across separate sandbox invocations", () => {
  test("sha256('') is the FIPS-180-4 empty-string vector", async () => {
    const out = await run<string>("return sk.sha256('');", {});
    expect(out).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("sha256('abc') matches the published vector and node:crypto", async () => {
    const expected = createHash("sha256").update("abc", "utf8").digest("hex");
    const fromJs = await run<string>("return sk.sha256('abc');", {});
    expect(fromJs).toBe(expected);
  });

  test("sha256 is deterministic: two separate invocations with the same input agree", async () => {
    const msg = "The quick brown fox jumps over the lazy dog";
    const a = await run<string>("return sk.sha256(input.m);", { m: msg });
    const b = await run<string>("return sk.sha256(input.m);", { m: msg });
    expect(a).toBe(b);
    expect(a).toBe(createHash("sha256").update(msg, "utf8").digest("hex"));
  });

  test("sha256 output is always 64 lowercase hex chars", async () => {
    const out = await run<string>("return sk.sha256('anything');", {});
    expect(out).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sk.hmacSha256 — determinism + RFC vector.
// ---------------------------------------------------------------------------

describe("sk.hmacSha256 — determinism across separate sandbox invocations", () => {
  test("hmacSha256 RFC 4231 test-case 2: key='Jefe', data='what do ya want for nothing?'", async () => {
    const out = await run<string>(
      "return sk.hmacSha256('Jefe', 'what do ya want for nothing?');",
      {},
    );
    expect(out).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  test("hmacSha256 is deterministic: same key+message → identical output on separate invocations", async () => {
    const key = "my-signing-key";
    const msg = "payload to sign";
    const a = await run<string>("return sk.hmacSha256(input.k, input.m);", { k: key, m: msg });
    const b = await run<string>("return sk.hmacSha256(input.k, input.m);", { k: key, m: msg });
    expect(a).toBe(b);
    expect(a).toBe(createHmac("sha256", key).update(msg, "utf8").digest("hex"));
  });

  test("hmacSha256 output is always 64 lowercase hex chars", async () => {
    const out = await run<string>("return sk.hmacSha256('k', 'm');", {});
    expect(out).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sk.uuid — determinism under a fixed seed + v4 shape invariant.
// ---------------------------------------------------------------------------

describe("sk.uuid — determinism under a fixed clock seed", () => {
  const clock = { now_ms: 1_700_000_000_000, seed: "regression-exec-001:step-encode" };

  test("uuid() is v4-shaped (variant 1, version 4)", async () => {
    const id = await runWithClock<string>("return sk.uuid();", clock);
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(id).toMatch(v4);
  });

  test("uuid() is reproducible: same seed yields the same sequence across invocations", async () => {
    const a = await runWithClock<string>("return sk.uuid();", clock);
    const b = await runWithClock<string>("return sk.uuid();", clock);
    expect(a).toBe(b);
  });

  test("uuid() diverges when the seed differs", async () => {
    const seedA = await runJs<string>({
      code: "return sk.uuid();",
      input: {},
      clock: { now_ms: 0, seed: "outage-seed-a" },
    });
    const seedB = await runJs<string>({
      code: "return sk.uuid();",
      input: {},
      clock: { now_ms: 0, seed: "outage-seed-b" },
    });
    expect(seedA.output).not.toBe(seedB.output);
  });
});

// ---------------------------------------------------------------------------
// sk.now / sk.nowIso — determinism under a fixed clock.
// Transforms that call sk.now() instead of Date.now() are reproducible
// under self-healing dry-runs; Date.now() is the banned form.
// ---------------------------------------------------------------------------

describe("sk.now / sk.nowIso — determinism under a fixed clock", () => {
  const clock = { now_ms: 1_700_000_000_000, seed: "regression-exec-001:step-now" };

  test("sk.now() returns the injected timestamp", async () => {
    const ts = await runWithClock<number>("return sk.now();", clock);
    expect(ts).toBe(clock.now_ms);
  });

  test("sk.nowIso() is the ISO-8601 form of the injected timestamp", async () => {
    const iso = await runWithClock<string>("return sk.nowIso();", clock);
    expect(iso).toBe(new Date(clock.now_ms).toISOString());
  });

  test("sk.now() is deterministic: same clock → same value across invocations", async () => {
    const a = await runWithClock<number>("return sk.now();", clock);
    const b = await runWithClock<number>("return sk.now();", clock);
    expect(a).toBe(b);
  });

  test("sk.now() defaults to 0 when no clock is injected", async () => {
    const out = await run<number>("return sk.now();", {});
    expect(out).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sk.base64UrlEncode — the correct Gmail raw encoding primitive.
// Verifies that a complete round-trip using sk.base64UrlEncode produces
// a valid url-safe base64 string with no "+" or "/" chars and no "undefined".
// ---------------------------------------------------------------------------

describe("sk.base64UrlEncode — the correct encoding primitive (outage regression)", () => {
  const GMAIL_MIME = "To: user@example.com\r\nSubject: Test\r\n\r\nHello, world!";

  test("sk.base64UrlEncode produces a url-safe base64 string (no + or /)", async () => {
    const encoded = await run<string>("return sk.base64UrlEncode(input.s);", {
      s: GMAIL_MIME,
    });
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("undefined");
  });

  test("sk.base64UrlEncode is deterministic: same input → same output across invocations", async () => {
    const a = await run<string>("return sk.base64UrlEncode(input.s);", { s: GMAIL_MIME });
    const b = await run<string>("return sk.base64UrlEncode(input.s);", { s: GMAIL_MIME });
    expect(a).toBe(b);
  });

  test("sk.base64UrlEncode matches the manual +→- /→_ substitution", async () => {
    const s = "ÿï¾"; // produces both + and / in standard base64
    const urlSafe = await run<string>("return sk.base64UrlEncode(input.s);", { s });
    const standard = await run<string>("return sk.base64Encode(input.s);", { s });
    expect(urlSafe).toBe(standard.replace(/\+/g, "-").replace(/\//g, "_"));
  });
});
