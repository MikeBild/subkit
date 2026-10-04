import { describe, expect, test } from "bun:test";
import { HttpRequestInvalidError, readBodyBytesCapped, readBodyCapped } from "./http.ts";

describe("readBodyCapped", () => {
  test("returns the body unchanged when under the cap", async () => {
    const res = new Response("hello world");
    expect(await readBodyCapped(res, 1024, "https://x/y")).toBe("hello world");
  });

  test("rejects early when Content-Length exceeds the cap (non-retryable)", async () => {
    const res = new Response("body", { headers: { "content-length": "999999999" } });
    await expect(readBodyCapped(res, 1024, "https://x/y")).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
  });

  test("aborts a chunked (no Content-Length) read once it exceeds the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(512).fill(65);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = new Response(stream);
    await expect(readBodyCapped(res, 1024, "https://x/y")).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
  });

  test("returns a just-under-cap streamed body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(500).fill(66));
        controller.close();
      },
    });
    const res = new Response(stream);
    const out = await readBodyCapped(res, 1024, "https://x/y");
    expect(out.length).toBe(500);
  });
});

describe("readBodyBytesCapped", () => {
  test("preserves binary bytes exactly (no UTF-8 mangling)", async () => {
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x80, 0xff, 0xfe]);
    const res = new Response(new Uint8Array(binary));
    const out = await readBodyBytesCapped(res, 1024, "https://x/y");
    expect(Buffer.compare(out, binary)).toBe(0);
  });

  test("enforces the byte cap on the non-stream fallback path", async () => {
    const res = new Response(new Uint8Array(2048));
    Object.defineProperty(res, "body", { value: null });
    await expect(readBodyBytesCapped(res, 1024, "https://x/y")).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
  });

  test("aborts a chunked binary read once it exceeds the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700).fill(0));
        controller.enqueue(new Uint8Array(700).fill(0));
        controller.close();
      },
    });
    const res = new Response(stream);
    await expect(readBodyBytesCapped(res, 1024, "https://x/y")).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
  });

  test("stops a body read when the request signal aborts after headers", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const pending = readBodyBytesCapped(
      new Response(stream),
      1024,
      "https://x/y",
      controller.signal,
    );
    queueMicrotask(() => controller.abort("timeout"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
});
