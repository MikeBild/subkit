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
