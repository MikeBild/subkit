import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { evaluate as jsonataEval } from "../../../../execution/jsonata-engine.ts";
import { runJs } from "../../runtime.ts";

const b64 = (code: string, input: unknown) =>
  runJs<string>({ code, input, clock: null }).then((r) => r.output);

describe("sk.base64Encode (byte-per-char, matches jsonata $base64encode)", () => {
  const cases = [
    "hello world",
    "",
    "a",
    "ab",
    "abc",
    "Veröffentlichung",
    "Projekt: Größe & Maß — 100% ✓",
    "Emoji: 😀",
    "To: user@example.com\r\nSubject: Essays published: 3\r\n\r\n<html>ä</html>",
  ];

  for (const s of cases) {
    test(`base64Encode === $base64encode for ${JSON.stringify(s).slice(0, 40)}`, async () => {
      const fromJs = await b64("return sk.base64Encode(input.s);", { s });
      const fromJsonata = await jsonataEval<string>("$base64encode($.s)", { s });
      expect(fromJs).toBe(fromJsonata);
    });
  }

  test("base64UrlEncode is the +→- /→_ url-safe variant, padding kept", async () => {
    const s = "ÿï¾";
    const url = await b64("return sk.base64UrlEncode(input.s);", { s });
    const std = await b64("return sk.base64Encode(input.s);", { s });
    expect(url).toBe(std.replace(/\+/g, "-").replace(/\//g, "_"));
    expect(url).not.toContain("+");
    expect(url).not.toContain("/");
  });

  test("base64UrlEncode matches the Gmail raw idiom these workflows use", async () => {
    const msg = "To: user@example.com\r\nSubject: Grüße\r\n\r\n<p>Maß</p>";
    const fromJs = await b64("return sk.base64UrlEncode(input.s);", { s: msg });
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
    const s = "࿿a";
    const url = await b64("return sk.base64UrlEncodeUtf8(input.s);", { s });
    const std = Buffer.from(s, "utf8").toString("base64");

    expect(url).toBe(std.replace(/\+/g, "-").replace(/\//g, "_"));
    expect(url).not.toContain("+");
    expect(url).not.toContain("/");
    expect(url.endsWith("=")).toBe(true);
  });
});

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
    await expect(
      runJs<string>({ code: "return btoa(input.s);", input: { s: "€" }, clock: null }),
    ).rejects.toThrow();
  });

  test("btoa accepts a Latin-1 code point (<= 255) like 'ä' without throwing", async () => {
    const out = await b64("return btoa(input.s);", { s: "ä" });
    expect(out).toBe(Buffer.from("ä", "binary").toString("base64"));
  });

  test("stdlib installs cleanly across sequential sandbox runs (fresh context per call)", async () => {
    const a = await b64("return btoa('a');", {});
    const c = await b64("return btoa('c');", {});
    expect(a).toBe(Buffer.from("a", "binary").toString("base64"));
    expect(c).toBe(Buffer.from("c", "binary").toString("base64"));
  });
});

describe("sk.hexEncode / sk.hexDecode (stdlib v1.4.0)", () => {
  const cases = ["", "a", "abc", "hello world", "ä", "\x00\x01\xfe\xff"];

  for (const s of cases) {
    test(`hexEncode matches Buffer binary hex for ${JSON.stringify(s).slice(0, 20)}`, async () => {
      const fromJs = await b64("return sk.hexEncode(input.s);", { s });
      expect(fromJs).toBe(Buffer.from(s, "binary").toString("hex"));
    });

    test(`hexDecode(hexEncode(x)) round-trips ${JSON.stringify(s).slice(0, 20)}`, async () => {
      const rt = await b64("return sk.hexDecode(sk.hexEncode(input.s));", { s });
      expect(rt).toBe(s);
    });
  }

  test("hexDecode tolerates whitespace and rejects odd-length / non-hex", async () => {
    const padded = await b64("return sk.hexDecode('68 65 6c 6c 6f');", {});
    expect(padded).toBe("hello");
    await expect(
      runJs({ code: "return sk.hexDecode('abc');", input: {}, clock: null }),
    ).rejects.toThrow();
    await expect(
      runJs({ code: "return sk.hexDecode('zz');", input: {}, clock: null }),
    ).rejects.toThrow();
  });
});

describe("sk.sha256 / sk.hmacSha256 (stdlib v1.4.0)", () => {
  test("sha256 known vectors", async () => {
    expect(await b64("return sk.sha256('');", {})).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await b64("return sk.sha256('abc');", {})).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  const messages = ["", "abc", "The quick brown fox jumps over the lazy dog", "Größe 😀 €"];
  for (const m of messages) {
    test(`sha256 matches node:crypto for ${JSON.stringify(m).slice(0, 20)}`, async () => {
      const fromJs = await b64("return sk.sha256(input.m);", { m });
      expect(fromJs).toBe(createHash("sha256").update(m, "utf8").digest("hex"));
    });
  }

  test("hmacSha256 RFC 4231 test case 2 vector", async () => {
    const out = await b64("return sk.hmacSha256('Jefe', 'what do ya want for nothing?');", {});
    expect(out).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  test("hmacSha256 matches node:crypto including a > 64-byte key", async () => {
    const key = "k".repeat(100);
    const msg = "payload to sign 😀";
    const fromJs = await b64("return sk.hmacSha256(input.key, input.msg);", { key, msg });
    expect(fromJs).toBe(createHmac("sha256", key).update(msg, "utf8").digest("hex"));
  });

  test("sha256 is deterministic across two runs", async () => {
    const a = await b64("return sk.sha256('repeat me');", {});
    const c = await b64("return sk.sha256('repeat me');", {});
    expect(a).toBe(c);
  });
});

describe("sk.now / sk.nowIso / sk.uuid (deterministic, stdlib v1.4.0)", () => {
  const clock = { now_ms: 1_700_000_000_000, seed: "exec-123:step-a" };
  const run = <T>(code: string) => runJs<T>({ code, input: {}, clock }).then((r) => r.output);

  test("now() returns the injected fixed timestamp; nowIso() is its ISO form", async () => {
    expect(await run<number>("return sk.now();")).toBe(clock.now_ms);
    expect(await run<string>("return sk.nowIso();")).toBe(new Date(clock.now_ms).toISOString());
  });

  test("now() is the SAME instant for every call within a run", async () => {
    const [a, b] = await run<[number, number]>(
      "const a = sk.now(); const b = sk.now(); return [a, b];",
    );
    expect(a).toBe(b);
  });

  test("now() defaults to 0 when no clock context is injected", async () => {
    const out = await runJs<number>({ code: "return sk.now();", input: {}, clock: null });
    expect(out.output).toBe(0);
  });

  test("uuid() is v4-shaped and distinct across calls within a run", async () => {
    const [u1, u2] = await run<[string, string]>("return [sk.uuid(), sk.uuid()];");
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(u1).toMatch(v4);
    expect(u2).toMatch(v4);
    expect(u1).not.toBe(u2);
  });

  test("uuid() is reproducible: same seed yields the same id sequence", async () => {
    const first = await run<string[]>("return [sk.uuid(), sk.uuid(), sk.uuid()];");
    const second = await run<string[]>("return [sk.uuid(), sk.uuid(), sk.uuid()];");
    expect(first).toEqual(second);
  });

  test("uuid() diverges when the seed differs", async () => {
    const a = await runJs<string>({
      code: "return sk.uuid();",
      input: {},
      clock: { now_ms: 0, seed: "seed-a" },
    });
    const b = await runJs<string>({
      code: "return sk.uuid();",
      input: {},
      clock: { now_ms: 0, seed: "seed-b" },
    });
    expect(a.output).not.toBe(b.output);
  });
});
