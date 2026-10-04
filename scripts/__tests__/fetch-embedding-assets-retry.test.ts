// Which download failures are worth a second attempt.
//
// The embedding assets are fetched inside the Docker build, so one unretried
// fetch is a single point of failure for the whole image: a dropped socket on
// one of five files failed the v6.0.2 `docker-publish` outright, with the
// release itself already published. Retrying is only correct for failures that
// describe the moment rather than the request — retrying a 404 fails slower and
// says nothing new.
//
// The classifier reads error text, which makes it the brittle half: a wording
// change upstream turns a retryable failure into a fatal one (or, worse, makes
// a permanent error look retryable and every build three times slower before it
// fails anyway). These cases hold the boundary.

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, isTransient } from "../fetch-embedding-assets.ts";

describe("isTransient", () => {
  test("the exact failure that broke a docker build", () => {
    // Copied verbatim from that run's log.
    expect(
      isTransient(
        new Error(
          "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        ),
      ),
    ).toBe(true);
  });

  test("server-side and connection-level failures retry", () => {
    for (const message of [
      "GET https://huggingface.co/x -> 503 Service Unavailable ",
      "GET https://huggingface.co/x -> 429 Too Many Requests ",
      "GET https://huggingface.co/x -> 408 Request Timeout ",
      "ECONNRESET",
      "EAI_AGAIN huggingface.co",
      "fetch failed",
    ]) {
      expect(isTransient(new Error(message))).toBe(true);
    }
  });

  test("a truncated body counts as transient", () => {
    // A short read is what a half-closed connection produces, and at this layer
    // it cannot be told apart from one. Treating it as permanent would bake a
    // corrupt model into the image — the failure mode the byte floors exist to
    // prevent in the first place.
    expect(
      isTransient(
        new Error("GET https://huggingface.co/x returned 812 bytes (< 50000000 expected)"),
      ),
    ).toBe(true);
  });

  test("the server's verdict is not retried", () => {
    // A 404 or a 403 answers the request. Retrying it three times only makes
    // the build slower before it fails with the same message.
    for (const message of [
      "GET https://huggingface.co/x -> 404 Not Found ",
      "GET https://huggingface.co/x -> 403 Forbidden ",
      "onnxruntime-web asset missing at /app/node_modules/... — run `bun install` before building",
    ]) {
      expect(isTransient(new Error(message))).toBe(false);
    }
  });
});

describe("download retry loop", () => {
  const tmp = () => join(tmpdir(), `sk-fea-${Math.random().toString(36).slice(2)}.bin`);
  const noSleep = async () => {};
  const body = (bytes: number) =>
    new Response(new Uint8Array(bytes), { status: 200, statusText: "OK" });

  test("a dropped socket is retried and the next attempt wins", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("The socket connection was closed unexpectedly.");
      return body(64);
    }) as unknown as typeof fetch;

    const dest = tmp();
    await download("https://example.test/a", dest, 8, flaky, noSleep);
    // Two calls, and the file is actually on disk — the retry produced the
    // asset, it did not merely swallow the error.
    expect(calls).toBe(2);
    expect(Bun.file(dest).size).toBe(64);
    rmSync(dest, { force: true });
  });

  test("a 404 is not retried", async () => {
    let calls = 0;
    const gone = (async () => {
      calls += 1;
      return new Response("", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;

    await expect(download("https://example.test/b", tmp(), 8, gone, noSleep)).rejects.toThrow(
      /404/,
    );
    expect(calls).toBe(1);
  });

  test("a persistently broken connection gives up after four attempts", async () => {
    let calls = 0;
    const dead = (async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await expect(download("https://example.test/c", tmp(), 8, dead, noSleep)).rejects.toThrow(
      /ECONNRESET/,
    );
    // Bounded: a build that cannot reach the CDN must fail, not hang.
    expect(calls).toBe(4);
  });
});
