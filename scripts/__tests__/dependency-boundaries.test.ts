import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const root = createRequire(import.meta.url);
const devtools = createRequire(root.resolve("react-devtools-core"));
const sdk = createRequire(root.resolve("@modelcontextprotocol/sdk/server/index.js"));
const express = createRequire(sdk.resolve("express"));
const shell = devtools("shell-quote");
const proxy = express("proxy-addr");
const ajv = createRequire(root.resolve("ajv"));
const uri = ajv("fast-uri");

describe("transitive dependency trust boundaries", () => {
  test("URI serialization rejects ports that replace the intended authority", () => {
    expect(() =>
      uri.serialize({
        scheme: "https",
        host: "trusted.example",
        port: "@127.0.0.1:8124",
        path: "/app",
      }),
    ).toThrow(TypeError);
    expect(
      uri.serialize({ scheme: "https", host: "trusted.example", port: 8443, path: "/app" }),
    ).toBe("https://trusted.example:8443/app");
  });

  test("shell quoting rejects line terminators after a comment", () => {
    for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(() =>
        shell.quote(["echo", "safe", { comment: "note" }, `a${separator}probe;#`]),
      ).toThrow(TypeError);
    }
  });

  test("shell quoting preserves ordinary literal arguments", () => {
    const argumentsToQuote = ["echo", "two words", "single'quote", "$literal", "line\nbreak"];
    expect(shell.parse(shell.quote(argumentsToQuote))).toEqual(argumentsToQuote);
  });

  test("IPv6 subnets cannot accidentally trust arbitrary IPv4 senders", () => {
    const request = {
      socket: { remoteAddress: "203.0.113.10" },
      headers: { "x-forwarded-for": "192.0.2.8" },
    };
    for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
      const trust = proxy.compile(subnet);
      expect(trust("203.0.113.10")).toBe(false);
      expect(proxy(request, trust)).toBe("203.0.113.10");
    }
  });

  test("correctly scoped mapped and plain IPv4 proxies retain forwarding", () => {
    for (const subnet of ["::ffff:10.0.0.0/104", "10.0.0.0/8"]) {
      const trust = proxy.compile(subnet);
      expect(trust("10.2.3.4")).toBe(true);
      expect(trust("203.0.113.10")).toBe(false);
      expect(
        proxy(
          { socket: { remoteAddress: "10.2.3.4" }, headers: { "x-forwarded-for": "192.0.2.8" } },
          trust,
        ),
      ).toBe("192.0.2.8");
    }
  });
});
