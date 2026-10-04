import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { runJs } from "../../runtime.ts";

const run = <T>(code: string, input: unknown): Promise<T> =>
  runJs<T>({ code, input, clock: null }).then((r) => r.output as T);

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

const CODE = "return sk.emailBody(input.message);";

describe("sk.emailBody", () => {
  test("single-part text/plain body decodes", async () => {
    const message = {
      id: "m1",
      snippet: "Hello wo…",
      payload: {
        mimeType: "text/plain",
        body: { size: 11, data: b64url("Hello world") },
      },
    };
    const out = await run<{ text: string | null; html: string | null }>(CODE, { message });
    expect(out).toEqual({ text: "Hello world", html: null });
  });

  test("multipart/alternative yields BOTH text and html", async () => {
    const message = {
      payload: {
        mimeType: "multipart/alternative",
        body: { size: 0 },
        parts: [
          { mimeType: "text/plain", body: { data: b64url("plain body") } },
          { mimeType: "text/html", body: { data: b64url("<p>html body</p>") } },
        ],
      },
    };
    const out = await run<{ text: string | null; html: string | null }>(CODE, { message });
    expect(out).toEqual({ text: "plain body", html: "<p>html body</p>" });
  });

  test("nested multipart/mixed → multipart/alternative is walked recursively", async () => {
    const message = {
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url("nested plain") } },
              { mimeType: "text/html", body: { data: b64url("<b>nested html</b>") } },
            ],
          },
          {
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            body: { attachmentId: "att-1", size: 12345 },
          },
        ],
      },
    };
    const out = await run<{ text: string | null; html: string | null }>(CODE, { message });
    expect(out).toEqual({ text: "nested plain", html: "<b>nested html</b>" });
  });

  test("UTF-8 multibyte content survives the decode (the mojibake class)", async () => {
    const body = "Größenänderung – ✓ 日本語";
    const message = {
      payload: { mimeType: "text/plain", body: { data: b64url(body) } },
    };
    const out = await run<{ text: string | null }>(CODE, { message });
    expect(out.text).toBe(body);
  });

  test("accepts a bare payload (no wrapper message)", async () => {
    const payload = { mimeType: "text/plain", body: { data: b64url("bare") } };
    const out = await run<{ text: string | null }>(CODE, { message: payload });
    expect(out.text).toBe("bare");
  });

  test("missing bodies yield nulls; unknown single-part mimeType falls back to text", async () => {
    const empty = await run<{ text: string | null; html: string | null }>(CODE, {
      message: { payload: { mimeType: "multipart/mixed", parts: [] } },
    });
    expect(empty).toEqual({ text: null, html: null });

    const fallback = await run<{ text: string | null; html: string | null }>(CODE, {
      message: { payload: { body: { data: b64url("no mime type") } } },
    });
    expect(fallback).toEqual({ text: "no mime type", html: null });
  });

  test("non-object input throws instead of returning a green empty shape", async () => {
    await expect(run(CODE, { message: "not a message" })).rejects.toThrow(/emailBody/);
  });

  test("a pre-decoded { body: { contentType, content } } message resolves without decoding", async () => {
    const html = await run<{ text: string | null; html: string | null }>(CODE, {
      message: {
        id: "graph-1",
        subject: "Team-Update",
        body: { contentType: "html", content: "<p>bereits dekodiert – ✓</p>" },
      },
    });
    expect(html).toEqual({ text: null, html: "<p>bereits dekodiert – ✓</p>" });

    const text = await run<{ text: string | null; html: string | null }>(CODE, {
      message: { body: { contentType: "text", content: "plain, pre-decoded" } },
    });
    expect(text).toEqual({ text: "plain, pre-decoded", html: null });
  });

  test("a Gmail payload whose body lacks contentType is NOT mistaken for the pre-decoded shape", async () => {
    const message = {
      payload: { mimeType: "text/plain", body: { size: 9, data: b64url("tree walk") } },
    };
    const out = await run<{ text: string | null; html: string | null }>(CODE, { message });
    expect(out).toEqual({ text: "tree walk", html: null });
  });
});
