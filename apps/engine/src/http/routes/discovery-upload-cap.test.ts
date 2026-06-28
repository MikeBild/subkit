// #39 — discovery upload cap (Content-Length fast-reject).
//
// Both multipart discovery routes (`POST /v1/discovery/runs` and
// `/from-archive`) buffer uploaded files into memory. Without a cap a
// single oversized upload can OOM the shared engine process. The
// authoritative guard is the running-total check inside the buffering
// loop; this advisory pre-check rejects with 413 BEFORE buffering when
// the (honest) Content-Length header already exceeds the cap. It is
// deliberately permissive when the header is absent (chunked encoding) —
// the buffering loop is the backstop there.

import { describe, expect, test } from "bun:test";
import { contentLengthOverCap, MAX_DISCOVERY_UPLOAD_BYTES } from "./discovery.ts";

function withContentLength(value: string | undefined): {
  req: { header: (n: string) => string | undefined };
} {
  return {
    req: {
      header: (n: string) => (n === "content-length" ? value : undefined),
    },
  };
}

describe("contentLengthOverCap", () => {
  test("no Content-Length header → not over cap (chunked; loop is the backstop)", () => {
    expect(contentLengthOverCap(withContentLength(undefined))).toBe(false);
  });

  test("Content-Length under the cap → not over cap", () => {
    expect(contentLengthOverCap(withContentLength(String(MAX_DISCOVERY_UPLOAD_BYTES - 1)))).toBe(
      false,
    );
  });

  test("Content-Length exactly at the cap → not over cap (cap is inclusive)", () => {
    expect(contentLengthOverCap(withContentLength(String(MAX_DISCOVERY_UPLOAD_BYTES)))).toBe(false);
  });

  test("Content-Length over the cap → over cap (413)", () => {
    expect(contentLengthOverCap(withContentLength(String(MAX_DISCOVERY_UPLOAD_BYTES + 1)))).toBe(
      true,
    );
  });

  test("non-numeric Content-Length → not over cap (ignored; loop is the backstop)", () => {
    expect(contentLengthOverCap(withContentLength("not-a-number"))).toBe(false);
  });

  test("the cap is 100 MB", () => {
    expect(MAX_DISCOVERY_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });
});
