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
  test("javascript: scheme is rejected", () => {
    expect(BrowserUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  test("data: scheme is rejected", () => {
    expect(BrowserUrlSchema.safeParse("data:text/html,<script>1</script>").success).toBe(false);
  });

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
