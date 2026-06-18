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
