import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
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

for (const contentLength of [undefined, "1", "999999999"]) {
  test(`response overflow cancels an open stream with declared length ${contentLength ?? "absent"}`, async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(513));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, {
      headers: contentLength ? { "content-length": contentLength } : {},
    });
    await expect(
      readBodyCapped(response, 1024, "https://example.test/body"),
    ).rejects.toBeInstanceOf(HttpRequestInvalidError);
    expect(cancelled).toBe(true);
  });
}

test("an overflowing response does not wait for an uncooperative cancellation promise", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    }),
  );
  await expect(readBodyCapped(response, 1024, "https://example.test/body")).rejects.toBeInstanceOf(
    HttpRequestInvalidError,
  );
  expect(cancelled).toBe(true);
});

test("split UTF-8 sequences obey the byte limit rather than decoded character count", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61, 0x61, 0xe2]));
        controller.enqueue(new Uint8Array([0x82, 0xac]));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(readBodyCapped(response, 4, "https://example.test/body")).rejects.toBeInstanceOf(
    HttpRequestInvalidError,
  );
  expect(cancelled).toBe(true);
});

test("native streamed HTTP overflow closes the upstream response", async () => {
  let closed = false;
  const server = createServer((_request, response) => {
    response.once("close", () => {
      closed = true;
    });
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.alloc(2048));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing stream fixture port");
    const response = await fetch(`http://127.0.0.1:${address.port}/stream`);
    await expect(readBodyCapped(response, 1024, "fixture stream")).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
    await waitFor(() => closed, { tries: 200, sleepMs: 5, label: "native response cancellation" });
    expect(closed).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
