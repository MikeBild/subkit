import { describe, expect, test } from "bun:test";
import { ADDRESS_CLASS_CASES, ORIGIN_CASES } from "./addresses.cases.ts";
import {
  classifyAddress,
  classifyHost,
  connectionAllowed,
  isIpLiteral,
  isPrivateClass,
  normalizeOrigin,
  originAllowed,
  PRIVATE_HOST_SUFFIXES,
  parseSiteEntry,
  RESERVED_HOST_SUFFIXES,
} from "./addresses.ts";
import type { PolicyResult } from "./result.ts";

function outcome(result: PolicyResult): string {
  return result.ok ? "ok" : result.code;
}

describe("address classes", () => {
  for (const c of ADDRESS_CLASS_CASES) {
    test(`${JSON.stringify(c.ip)} is ${c.expected}`, () => {
      expect(classifyAddress(c.ip)).toBe(c.expected);
    });
  }

  test("only public counts as not private", () => {
    expect(isPrivateClass("public")).toBe(false);
    for (const value of ["private", "loopback", "link_local", "reserved"] as const) {
      expect(isPrivateClass(value)).toBe(true);
    }
  });

  test("IP literals are recognized with brackets, zones and spaces", () => {
    expect(isIpLiteral(" 10.0.0.1 ")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("fe80::1%en0")).toBe(true);
    expect(isIpLiteral("[::1")).toBe(false);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("1::1]")).toBe(false);
    expect(isIpLiteral("%en0")).toBe(false);
  });

  test("IPv6 parsing is exact about groups, gaps and embedded IPv4", () => {
    const literals: readonly [string, boolean][] = [
      ["::", true],
      ["1::", true],
      ["::1", true],
      ["1:2:3:4:5:6::7", true],
      ["1:2:3:4:5:6:7::", true],
      ["1:2:3:4:5:6:7:8", true],
      ["::ffff:1.2.3.4", true],
      ["1:2:3:4:5:6:1.2.3.4", true],
      ["1:2:3:4:5::1.2.3.4", true],
      ["1:2:3:4:5:6:7:8:9", false],
      ["1:2:3:4:5:6:7", false],
      ["1:2:3:4:5:6:7::8", false],
      ["1::2::3", false],
      ["1:::2", false],
      ["::ffff:999.0.0.1", false],
      ["::ffff:1.2.3", false],
      ["1:2:3:4:5:6:7:1.2.3.4", false],
      ["1:2:3:4:5:1.2.3.4", false],
      ["g::1", false],
      ["1::g", false],
      ["12345::1", false],
      ["1.2.3.4.5", false],
    ];
    for (const [value, expected] of literals)
      expect([value, isIpLiteral(value)]).toEqual([value, expected]);
  });

  test("classification trims, strips zones and reads embedded addresses exactly", () => {
    const classes: readonly [string, string][] = [
      [" 10.0.0.1 ", "private"],
      ["fe80::1%en0%x", "link_local"],
      ["::2", "reserved"],
      ["::a00:1", "private"],
      ["::ffff:1:a00:1", "reserved"],
      ["1::ffff:0:a00:1", "reserved"],
      ["64:ff9c::a00:1", "reserved"],
      ["65:ff9b::a00:1", "reserved"],
      ["64:ff9b:0:0:0:1:a00:1", "reserved"],
      ["64:ff9c:1::1", "reserved"],
      ["65:ff9b:1::1", "reserved"],
      ["64:ff9b:2::1", "reserved"],
      ["2400::1", "public"],
      ["2400:db8::1", "public"],
      ["2400:10::1", "public"],
      ["2400:20::1", "public"],
      ["2001:db9::1", "public"],
      ["2001:1::1", "public"],
      ["2001:40::1", "public"],
      ["3ffe::1", "public"],
      ["fbff::1", "reserved"],
      ["fe00::1", "reserved"],
      ["fec0::1", "private"],
      ["feff::1", "private"],
      ["fd00::1", "private"],
      ["2002:a00:1::", "private"],
      ["223.255.255.255", "public"],
      ["224.0.0.0", "reserved"],
      ["192.0.1.255", "public"],
      ["192.0.3.0", "public"],
      ["192.88.98.255", "public"],
      ["192.88.100.0", "public"],
      ["198.17.255.255", "public"],
      ["198.51.99.255", "public"],
      ["198.51.101.0", "public"],
      ["203.0.112.255", "public"],
      ["203.0.114.0", "public"],
      ["192.0.1.0", "public"],
      ["11.0.0.0", "public"],
      ["9.255.255.255", "public"],
      ["169.253.255.255", "public"],
      ["169.255.0.0", "public"],
      ["128.0.0.0", "public"],
      ["1.0.0.0", "public"],
      ["192.167.255.255", "public"],
    ];
    for (const [value, expected] of classes) {
      expect([value, classifyAddress(value)]).toEqual([value, expected]);
    }
  });
});

describe("host classes", () => {
  const cases: readonly [string, string][] = [
    ["example.com", "public"],
    ["Shop.Example.COM.", "public"],
    ["localhost", "loopback"],
    ["LOCALHOST.", "loopback"],
    ["app.localhost", "loopback"],
    ["printer.local", "private"],
    ["router.home.arpa", "private"],
    ["db.internal", "private"],
    ["nas.lan", "private"],
    ["wiki.intranet", "private"],
    ["mail.corp", "private"],
    ["box.home", "private"],
    ["intranet", "private"],
    ["1.0.0.127.in-addr.arpa", "reserved"],
    ["a.invalid", "reserved"],
    ["a.test", "reserved"],
    ["a.example", "reserved"],
    ["abc.onion", "reserved"],
    ["", "reserved"],
    [".", "reserved"],
    ["[::1]", "loopback"],
    ["192.168.0.1", "private"],
    ["8.8.8.8", "public"],
    ["notlocal", "private"],
    ["mylocal.com", "public"],
  ];
  for (const [host, expected] of cases) {
    test(`${JSON.stringify(host)} is ${expected}`, () => {
      expect<string>(classifyHost(host)).toBe(expected);
    });
  }
});

describe("host suffix lists", () => {
  test("every private and reserved suffix is applied, after trimming", () => {
    for (const suffix of PRIVATE_HOST_SUFFIXES) {
      expect([suffix, classifyHost(` box${suffix.toUpperCase()} `)]).toEqual([suffix, "private"]);
    }
    for (const suffix of RESERVED_HOST_SUFFIXES) {
      expect([suffix, classifyHost(`box${suffix}`)]).toEqual([suffix, "reserved"]);
    }
    expect(classifyHost(" localhost ")).toBe("loopback");
  });
});

describe("origins", () => {
  test("normalize scheme, host, default ports and private flag", () => {
    expect(normalizeOrigin("HTTPS://Shop.Example.com:443/a?b#c")).toEqual({
      origin: "https://shop.example.com",
      scheme: "https",
      host: "shop.example.com",
      port: 443,
      default_port: true,
      host_class: "public",
    });
    expect(normalizeOrigin("http://example.com")).toMatchObject({ port: 80, default_port: true });
    expect(normalizeOrigin("http://example.com:80")).toMatchObject({
      origin: "http://example.com",
      port: 80,
    });
    expect(normalizeOrigin("http://192.168.1.1:8080/")).toEqual({
      origin: "http://192.168.1.1:8080",
      scheme: "http",
      host: "192.168.1.1",
      port: 8080,
      default_port: false,
      host_class: "private",
    });
    expect(normalizeOrigin("https://[::1]:8443")).toMatchObject({
      origin: "https://[::1]:8443",
      host_class: "loopback",
    });
    expect(normalizeOrigin("  https://example.com  ")?.origin).toBe("https://example.com");
    expect(normalizeOrigin("mailto:a@example.com")).toBeNull();
    expect(normalizeOrigin("https://:pw@example.com")).toBeNull();
    expect(normalizeOrigin("nope")).toBeNull();
  });

  test("a site entry is a bare origin", () => {
    expect(parseSiteEntry("https://example.com")?.origin).toBe("https://example.com");
    expect(parseSiteEntry("https://example.com/")?.origin).toBe("https://example.com");
    expect(parseSiteEntry("http://192.168.1.1:8080")?.host_class).toBe("private");
    expect(parseSiteEntry("https://example.com/path")).toBeNull();
    expect(parseSiteEntry("https://example.com/?")).toBeNull();
    expect(parseSiteEntry("https://example.com#")).toBeNull();
    expect(parseSiteEntry("https://example.com?a=1")).toBeNull();
    expect(parseSiteEntry("https://example.com/#x")).toBeNull();
    expect(parseSiteEntry("https://u:p@example.com")).toBeNull();
    expect(parseSiteEntry("example.com")).toBeNull();
    expect(parseSiteEntry("file:///")).toBeNull();
  });
});

describe("origin and connection cases", () => {
  test("cover both directions", () => {
    expect(ORIGIN_CASES.some((c) => c.direction === "needless_ask")).toBe(true);
    expect(ORIGIN_CASES.some((c) => c.direction === "over_permission")).toBe(true);
    expect(new Set(ORIGIN_CASES.map((c) => c.id)).size).toBe(ORIGIN_CASES.length);
  });

  for (const c of ORIGIN_CASES) {
    test(`${c.id} → ${c.expected}`, () => {
      const result =
        c.resolved_ip === undefined
          ? originAllowed(c.url, c.allowances)
          : connectionAllowed(c.url, c.resolved_ip, c.allowances);
      expect(outcome(result)).toBe(c.expected);
    });
  }

  test("an allowed origin answers a plain ok", () => {
    const allowances = [{ origin: "http://192.168.1.1", entered_by: "person" as const }];
    expect(originAllowed("http://192.168.1.1/", allowances)).toEqual({ ok: true });
    expect(connectionAllowed("http://192.168.1.1/", "192.168.1.1", allowances)).toEqual({
      ok: true,
    });
  });

  test("an unparseable allowance never matches", () => {
    expect(
      outcome(originAllowed("https://example.com/", [{ origin: "nope", entered_by: "person" }])),
    ).toBe("origin_not_allowed");
  });

  test("a connection is refused when the origin itself is refused", () => {
    expect(outcome(connectionAllowed("https://a.example.org/", "8.8.8.8", []))).toBe(
      "origin_not_allowed",
    );
  });
});
