import { describe, expect, test } from "bun:test";
import { canonicalHostList, canonicalHostname, destinationHostIssue } from "./allowed-hosts.ts";

describe("canonicalHostname", () => {
  test("accepts plain host names and returns their lower-case ascii form", () => {
    expect(canonicalHostname("docs.example.com")).toBe("docs.example.com");
    expect(canonicalHostname("Docs.Example.COM")).toBe("docs.example.com");
    expect(canonicalHostname("café.example")).toBe("xn--caf-dma.example");
    expect(canonicalHostname("xn--caf-dma.example")).toBe("xn--caf-dma.example");
  });

  test("refuses anything that is not one host name", () => {
    for (const value of [
      "",
      "localhost",
      "example.com.",
      "*.example.com",
      "example.com:8443",
      "https://example.com",
      "example.com/path",
      "user@example.com",
      "127.0.0.1",
      "[::1]",
      "exa mple.com",
      "-bad.example.com",
      "example..com",
      "a%2eexample.com",
      42,
      null,
    ])
      expect(canonicalHostname(value)).toBeNull();
  });
});

describe("canonicalHostList", () => {
  test("sorts, de-duplicates and canonicalises the list", () => {
    expect(canonicalHostList(["B.example.com", "a.example.com", "b.example.com"])).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
  });

  test("refuses an empty, oversized, non-array or partly invalid list", () => {
    expect(canonicalHostList([])).toBeNull();
    expect(canonicalHostList("example.com")).toBeNull();
    expect(canonicalHostList(["example.com", "*.example.com"])).toBeNull();
    expect(
      canonicalHostList(Array.from({ length: 51 }, (_, index) => `h${index}.example.com`)),
    ).toBeNull();
  });
});

describe("destinationHostIssue", () => {
  const hosts = ["docs.example.com", "xn--caf-dma.example"];
  const issue = (url: string) => destinationHostIssue(hosts, new URL(url));

  test("allows https on a listed host with any path and query", () => {
    expect(issue("https://docs.example.com/a/b?c=1")).toBeNull();
    expect(issue("https://DOCS.example.com/")).toBeNull();
    expect(issue("https://docs.example.com:443/")).toBeNull();
    expect(issue("https://café.example/page")).toBeNull();
  });

  test("refuses every other scheme, userinfo, port or host", () => {
    expect(issue("http://docs.example.com/")).toBe("scheme");
    expect(issue("https://docs.example.com@evil.example.net/")).toBe("userinfo");
    expect(issue("https://user:pw@docs.example.com/")).toBe("userinfo");
    expect(issue("https://docs.example.com:8443/")).toBe("port");
    expect(issue("https://docs.example.com./")).toBe("host");
    expect(issue("https://evil.docs.example.com/")).toBe("host");
    expect(issue("https://docs.example.com.evil.example.net/")).toBe("host");
    expect(issue("https://cafe.example/")).toBe("host");
    expect(issue(`https://${String.fromCodePoint(0x435)}xample.com/`)).toBe("host");
  });
});
