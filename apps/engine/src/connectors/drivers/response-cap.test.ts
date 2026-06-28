// #38 — bounded response read. A single oversized upstream response must
// not be buffered unbounded into the shared engine process. readBodyCapped
// rejects early on a Content-Length over the cap and aborts a chunked read
// once the running total exceeds it, throwing the non-retryable
// HttpRequestInvalidError; under-cap responses are returned unchanged.

import { describe, expect, test } from "bun:test";
import { HttpRequestInvalidError, readBodyCapped } from "./http.ts";

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
        const chunk = new Uint8Array(512).fill(65); // 'A'
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 1536 bytes total, cap is 1024
        controller.close();
      },
    });
    const res = new Response(stream); // chunked → no Content-Length
    await expect(readBodyCapped(res, 1024, "https://x/y")).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
  });

  test("returns a just-under-cap streamed body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(500).fill(66)); // 'B'
        controller.close();
      },
    });
    const res = new Response(stream);
    const out = await readBodyCapped(res, 1024, "https://x/y");
    expect(out.length).toBe(500);
  });
});
