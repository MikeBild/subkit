// Unit tests for the browser-launch URL boundary.
//
// `BrowserUrlSchema` / `assertHttpsUrl` gate every URL handed to
// `spawn(bin, [url])` for the operator's default browser. `shell: false`
// already neutralises shell-injection, but it does NOT stop URL-scheme
// abuse — `xdg-open file:///etc/passwd` would still launch a file
// reader. The schema is the positive `^https?://` allowlist that closes
// that hole, so it must be directly tested: http(s) passes, every other
// scheme (and a scheme-less string) is rejected.

import { describe, expect, test } from "bun:test";

import { assertHttpsUrl, BrowserUrlSchema } from "./open-browser.ts";

describe("BrowserUrlSchema — allowlisted http(s) URLs pass", () => {
  test("https:// URL is accepted", () => {
    const r = BrowserUrlSchema.safeParse("https://engine.example.com/v1/oauth/callback");
    expect(r.success).toBe(true);
  });

  test("http:// URL is accepted", () => {
    const r = BrowserUrlSchema.safeParse("http://localhost:3000/cb");
    expect(r.success).toBe(true);
  });
});

describe("BrowserUrlSchema — non-http(s) schemes are rejected", () => {
  // `javascript:` URLs pass `z.string().url()` but are a code-execution
  // vector — the `^https?://` refine is what rejects them.
  test("javascript: scheme is rejected", () => {
    expect(BrowserUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  test("data: scheme is rejected", () => {
    expect(BrowserUrlSchema.safeParse("data:text/html,<script>1</script>").success).toBe(false);
  });

  // `file:` is the canonical local-file-read abuse `shell: false` cannot
  // stop — the allowlist is the only thing blocking it.
  test("file: scheme is rejected", () => {
    expect(BrowserUrlSchema.safeParse("file:///etc/passwd").success).toBe(false);
  });

  test("a scheme-less string is rejected", () => {
    expect(BrowserUrlSchema.safeParse("engine.example.com/cb").success).toBe(false);
  });
});

describe("assertHttpsUrl — validated entry point", () => {
  test("returns the validated string for an http(s) URL", () => {
    const url = "https://engine.example.com/v1/oauth/callback";
    expect(assertHttpsUrl(url)).toBe(url);
  });

  test("throws for a non-http(s) scheme", () => {
    expect(() => assertHttpsUrl("file:///etc/passwd")).toThrow();
    expect(() => assertHttpsUrl("javascript:alert(1)")).toThrow();
  });

  test("the thrown message names the http(s) requirement", () => {
    expect(() => assertHttpsUrl("file:///etc/passwd")).toThrow(/http\(s\)/);
  });
});
