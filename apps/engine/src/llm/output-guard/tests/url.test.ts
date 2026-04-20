// Unit tests for the URL grounding scanner.

import { describe, expect, it } from "bun:test";
import { urlScanner } from "../scanners/url.ts";

describe("urlScanner", () => {
  it("passes when the emitted URL matches engine_url", () => {
    const vs = urlScanner.scan("Hit https://subkit-api.mikebild.dev/mcp now.", {
      engine_url: "https://subkit-api.mikebild.dev",
    });
    expect(vs).toEqual([]);
  });

  it("flags a subkit-shaped URL whose origin differs from engine_url", () => {
    const vs = urlScanner.scan("Hit https://subkit-api.other.dev/mcp now.", {
      engine_url: "https://subkit-api.mikebild.dev",
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("url.unknown_origin");
    expect(vs[0]?.details).toMatchObject({
      emitted_origin: "https://subkit-api.other.dev",
      engine_url_origin: "https://subkit-api.mikebild.dev",
    });
  });

  it("ignores foreign hosts (github, anthropic, vendor docs)", () => {
    const vs = urlScanner.scan(
      "See https://github.com/anthropics or https://docs.anthropic.com.",
      { engine_url: "https://subkit-api.mikebild.dev" },
    );
    expect(vs).toEqual([]);
  });

  it("flags subkit-shaped URLs even when no engine_url is in context", () => {
    const vs = urlScanner.scan("hit https://subkit-api.example.dev/mcp", {});
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("url.unknown_origin");
  });

  it("flags localhost URLs only when an engine_url is set", () => {
    expect(
      urlScanner.scan("http://localhost:8080/foo", {
        engine_url: "http://127.0.0.1:4000",
      }),
    ).toHaveLength(1);
    expect(urlScanner.scan("http://localhost:8080/foo", {})).toEqual([]);
  });

  it("handles multiple URLs in one block", () => {
    const text =
      "Try https://subkit-api.first.dev/mcp or https://subkit-api.second.dev/mcp or even https://github.com.";
    const vs = urlScanner.scan(text, { engine_url: "https://subkit-api.mikebild.dev" });
    expect(vs.map((v) => v.details?.emitted_origin)).toEqual([
      "https://subkit-api.first.dev",
      "https://subkit-api.second.dev",
    ]);
  });

  it("does not panic on malformed URLs", () => {
    const vs = urlScanner.scan("https://", { engine_url: "https://subkit-api.mikebild.dev" });
    expect(vs).toEqual([]);
  });

  it("does not panic on a malformed engine_url", () => {
    expect(() =>
      urlScanner.scan("https://subkit-api.x.dev/foo", { engine_url: "not a url" }),
    ).not.toThrow();
  });
});
