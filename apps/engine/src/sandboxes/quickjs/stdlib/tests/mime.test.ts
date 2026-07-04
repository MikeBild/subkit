// sk.mimeEncodeHeaderValue / sk.buildMimeMessage — the MIME surface that
// keeps email-send workflows RFC-compliant. Headers are ASCII-only by
// RFC 5322; the prod incident this pins: an authored transform placed a
// raw UTF-8 en-dash in the Subject header, the receiving server decoded
// the bytes as Latin-1 and re-encoded, and the inbox showed
// "Ã¢Â€Â“" instead of "–". These tests run inside the real QuickJS
// sandbox and verify the wire bytes with Node's own decoders.

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { runJs } from "../../runtime.ts";

const run = <T>(code: string, input: unknown): Promise<T> =>
  runJs<T>({ code, input, clock: null }).then((r) => r.output as T);

/** Decode a chain of RFC 2047 B-encoded words back to the original text. */
function decodeEncodedWords(headerValue: string): string {
  return headerValue
    .split(/\r\n\s/)
    .map((word) => {
      const m = word.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
      if (!m?.[1]) throw new Error(`not an encoded-word: ${word}`);
      return Buffer.from(m[1], "base64").toString("utf8");
    })
    .join("");
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("sk.mimeEncodeHeaderValue", () => {
  test("ASCII-printable values pass through unchanged", async () => {
    const out = await run<string>("return sk.mimeEncodeHeaderValue(input.s);", {
      s: "Daily Report 2026-07-03 (100%)",
    });
    expect(out).toBe("Daily Report 2026-07-03 (100%)");
  });

  test("the prod en-dash subject becomes a decodable encoded-word", async () => {
    const s = "GA4 Daily Report mikebild.dev – 2026-07-03";
    const out = await run<string>("return sk.mimeEncodeHeaderValue(input.s);", { s });
    expect(out.startsWith("=?UTF-8?B?")).toBe(true);
    expect(out.endsWith("?=")).toBe(true);
    // The header value itself must be pure ASCII on the wire.
    expect(/^[\x20-\x7e\r\n]*$/.test(out)).toBe(true);
    expect(decodeEncodedWords(out)).toBe(s);
  });

  test("long non-ASCII values fold into ≤75-char words without splitting characters", async () => {
    const s = `Größenänderung übermäßig langer Betreffzeilen — ${"ä".repeat(60)} ✓`;
    const out = await run<string>("return sk.mimeEncodeHeaderValue(input.s);", { s });
    const words = out.split(/\r\n\s/);
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      // Each word must decode standalone — proving no UTF-8 sequence was
      // split across a chunk boundary.
      const decoded = decodeEncodedWords(word);
      expect(decoded.includes("�")).toBe(false);
    }
    expect(decodeEncodedWords(out)).toBe(s);
  });
});

describe("sk.buildMimeMessage", () => {
  const CODE = "return sk.buildMimeMessage(input.opts);";

  test("html message: ASCII-only headers, encoded subject, decodable body", async () => {
    const opts = {
      from: "mike@mikebild.com",
      to: "mike@mikebild.com",
      subject: "GA4 Daily Report mikebild.dev – 2026-07-03",
      html: "<h1>Bericht</h1><p>Keine Daten für gestern — Property zu jung.</p>",
    };
    const { raw, mime } = await run<{ raw: string; mime: string }>(CODE, { opts });
    expect(decodeRaw(raw)).toBe(mime);

    const [headerBlock, ...bodyParts] = mime.split("\r\n\r\n");
    const body = bodyParts.join("\r\n\r\n");
    // Every header byte is ASCII — the property whose violation caused
    // the prod mojibake.
    expect(/^[\x20-\x7e\r\n]*$/.test(headerBlock ?? "")).toBe(true);
    expect(headerBlock).toContain("MIME-Version: 1.0");
    expect(headerBlock).toContain("Content-Type: text/html; charset=UTF-8");
    expect(headerBlock).toContain("Content-Transfer-Encoding: base64");
    const subjectLine = (headerBlock ?? "").split("\r\n").find((l) => l.startsWith("Subject: "));
    expect(subjectLine).toBeDefined();
    expect(decodeEncodedWords((subjectLine ?? "").slice("Subject: ".length))).toBe(opts.subject);
    // Body decodes back to the exact html.
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(opts.html);
  });

  test("html + text becomes multipart/alternative with both parts decodable", async () => {
    const opts = {
      from: "a@example.com",
      to: ["b@example.com", "c@example.com"],
      subject: "Zwei Teile",
      text: "Nur Text – schlicht.",
      html: "<p>Reich – mit Markup.</p>",
    };
    const { mime } = await run<{ raw: string; mime: string }>(CODE, { opts });
    expect(mime).toContain("To: b@example.com, c@example.com");
    const boundaryMatch = mime.match(/multipart\/alternative; boundary="([^"]+)"/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch?.[1] ?? "";
    const parts = mime.split(`--${boundary}`);
    // preamble, text part, html part, closing "--"
    expect(parts.length).toBe(4);
    expect(parts[1]).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(parts[2]).toContain("Content-Type: text/html; charset=UTF-8");
    const b64Of = (part: string | undefined) =>
      (part ?? "").split("\r\n\r\n")[1]?.replace(/[\r\n-]/g, "") ?? "";
    expect(Buffer.from(b64Of(parts[1]), "base64").toString("utf8")).toBe(opts.text);
    expect(Buffer.from(b64Of(parts[2]), "base64").toString("utf8")).toBe(opts.html);
  });

  test("deterministic: identical inputs produce identical raw", async () => {
    const opts = {
      from: "a@example.com",
      to: "b@example.com",
      subject: "Stabil",
      html: "<p>x</p>",
      text: "x",
    };
    const one = await run<{ raw: string }>(CODE, { opts });
    const two = await run<{ raw: string }>(CODE, { opts });
    expect(one.raw).toBe(two.raw);
  });

  test("non-ASCII address fields throw instead of corrupting routing", async () => {
    await expect(
      run(CODE, {
        opts: { from: "Jörg <j@example.com>", to: "b@example.com", text: "x" },
      }),
    ).rejects.toThrow(/must be ASCII/);
  });

  test("missing body throws", async () => {
    await expect(
      run(CODE, { opts: { from: "a@example.com", to: "b@example.com", subject: "x" } }),
    ).rejects.toThrow(/html and\/or text/);
  });
});
