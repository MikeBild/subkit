// sk.base64Encode / sk.base64UrlEncode — the encoding surface the
// email-send (`raw`) and git-commit (`content`) workflows depend on once
// their transforms move from jsonata to javascript. The contract is
// byte-identical output to jsonata's `$base64encode` (low-8-bit binary
// string semantics, not UTF-8), so a transform can switch language
// without changing what it sends. Separate UTF-8 helpers exist for new
// Unicode-safe payloads. These tests run the JS inside the real QuickJS
// sandbox and compare against the engine's jsonata runtime — the same
// two runtimes production uses.

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { evaluate as jsonataEval } from "../../../../execution/jsonata-engine.ts";
import { runJs } from "../../runtime.ts";

const b64 = (code: string, input: unknown) => runJs<string>({ code, input }).then((r) => r.output);

describe("sk.base64Encode (byte-per-char, matches jsonata $base64encode)", () => {
  const cases = [
    "hello world",
    "", // empty
    "a", // 1 byte → 2 pad
    "ab", // 2 bytes → 1 pad
    "abc", // 3 bytes → 0 pad
    "Veröffentlichung", // German umlaut (multi-byte)
    "Projekt: Größe & Maß — 100% ✓", // mixed multi-byte + symbol + check mark
    "Emoji: 😀", // surrogate pair must preserve jsonata's historical low-byte behavior
    "To: user@example.com\r\nSubject: Essays published: 3\r\n\r\n<html>ä</html>", // MIME shape
  ];

  for (const s of cases) {
    test(`base64Encode === $base64encode for ${JSON.stringify(s).slice(0, 40)}`, async () => {
      const fromJs = await b64("return sk.base64Encode(input.s);", { s });
      const fromJsonata = await jsonataEval<string>("$base64encode($.s)", { s });
      expect(fromJs).toBe(fromJsonata);
    });
  }

  test("base64UrlEncode is the +→- /→_ url-safe variant, padding kept", async () => {
    // A payload whose base64 carries both `+` and `/` so the substitution
    // is actually exercised.
    const s = "ÿï¾"; // bytes that produce + and / in base64
    const url = await b64("return sk.base64UrlEncode(input.s);", { s });
    const std = await b64("return sk.base64Encode(input.s);", { s });
    expect(url).toBe(std.replace(/\+/g, "-").replace(/\//g, "_"));
    expect(url).not.toContain("+");
    expect(url).not.toContain("/");
  });

  test("base64UrlEncode matches the Gmail raw idiom these workflows use", async () => {
    const msg = "To: user@example.com\r\nSubject: Grüße\r\n\r\n<p>Maß</p>";
    const fromJs = await b64("return sk.base64UrlEncode(input.s);", { s: msg });
    // The exact jsonata expression daily-do-resources-email / publish-ready-essays use.
    const fromJsonata = await jsonataEval<string>(
      "$replace($replace($base64encode($.s), '+', '-'), '/', '_')",
      { s: msg },
    );
    expect(fromJs).toBe(fromJsonata);
  });

  test("base64EncodeUtf8 is explicit Unicode-safe encoding, not the migration helper", async () => {
    const s = "Größe 😀";
    const fromUtf8 = await b64("return sk.base64EncodeUtf8(input.s);", { s });
    const fromJsonataCompat = await b64("return sk.base64Encode(input.s);", { s });

    expect(fromUtf8).toBe(Buffer.from(s, "utf8").toString("base64"));
    expect(fromUtf8).not.toBe(fromJsonataCompat);
  });

  test("base64UrlEncodeUtf8 applies url-safe substitutions while keeping padding", async () => {
    const s = "࿿a"; // UTF-8 bytes produce +, /, and padding in base64.
    const url = await b64("return sk.base64UrlEncodeUtf8(input.s);", { s });
    const std = Buffer.from(s, "utf8").toString("base64");

    expect(url).toBe(std.replace(/\+/g, "-").replace(/\//g, "_"));
    expect(url).not.toContain("+");
    expect(url).not.toContain("/");
    expect(url.endsWith("=")).toBe(true);
  });
});

// Decode side + the familiar `btoa`/`atob` globals — added in stdlib
// v1.3.0. Pre-fix the sandbox installed no `btoa`/`Buffer`, so authors
// reached for `btoa` by reflex, failed, and hand-rolled an encoder
// instead of finding `sk.base64EncodeUtf8` (production Gmail MIME build).
// There was also NO decode path at all.
describe("base64 decode + btoa/atob globals (stdlib v1.3.0)", () => {
  const unicode = ["", "a", "ab", "abc", "Größe 😀", "Toulon → Ajaccio 185,00 €", "ä€"];

  for (const s of unicode) {
    test(`base64DecodeUtf8(base64EncodeUtf8(x)) round-trips ${JSON.stringify(s).slice(0, 30)}`, async () => {
      const rt = await b64("return sk.base64DecodeUtf8(sk.base64EncodeUtf8(input.s));", { s });
      expect(rt).toBe(s);
    });
  }

  test("base64DecodeUtf8 tolerates url-safe alphabet and missing padding", async () => {
    const s = "Toulon → Ajaccio";
    const rt = await b64(
      "return sk.base64DecodeUtf8(sk.base64UrlEncodeUtf8(input.s).replace(/=+$/, ''));",
      { s },
    );
    expect(rt).toBe(s);
  });

  test("btoa global matches sk.base64Encode (binary-string Web semantics)", async () => {
    const s = "hello world";
    const fromBtoa = await b64("return btoa(input.s);", { s });
    const fromSk = await b64("return sk.base64Encode(input.s);", { s });
    expect(fromBtoa).toBe(fromSk);
    expect(fromBtoa).toBe(Buffer.from(s, "binary").toString("base64"));
  });

  test("atob global is the inverse of btoa (binary string)", async () => {
    const s = "hello world";
    const rt = await b64("return atob(btoa(input.s));", { s });
    expect(rt).toBe(s);
  });

  test("btoa throws on code points > 255 (Web parity; use sk.base64EncodeUtf8 for Unicode)", async () => {
    // "€" is U+20AC (8364 > 255). runJs surfaces an in-sandbox throw by rejecting.
    await expect(
      runJs<string>({ code: "return btoa(input.s);", input: { s: "€" } }),
    ).rejects.toThrow();
  });

  test("btoa accepts a Latin-1 code point (<= 255) like 'ä' without throwing", async () => {
    // charCode 0xE4 (228) fits one byte — Web btoa accepts it.
    const out = await b64("return btoa(input.s);", { s: "ä" });
    expect(out).toBe(Buffer.from("ä", "binary").toString("base64"));
  });

  test("stdlib installs cleanly across sequential sandbox runs (fresh context per call)", async () => {
    // Each runJs builds a fresh QuickJS context and installs the stdlib
    // (sk + btoa/atob) once. Two sequential runs must both succeed — i.e.
    // the non-configurable defineProperty installs never collide across
    // contexts (no long-lived context reused with a second install).
    const a = await b64("return btoa('a');", {});
    const c = await b64("return btoa('c');", {});
    expect(a).toBe(Buffer.from("a", "binary").toString("base64"));
    expect(c).toBe(Buffer.from("c", "binary").toString("base64"));
  });
});
