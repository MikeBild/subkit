// Egress guard unit tests. Pin the SSRF blocklist so a future refactor
// can't silently regress private-IP exfiltration protection.
//
// Coverage targets:
//   - Every RFC 1918 + loopback + link-local + IPv6 unique-local range.
//   - 169.254.169.254 specifically (AWS EC2 metadata is the canonical
//     SSRF target and the post-Capital One CVE pivot point).
//   - IPv4-mapped IPv6 in BOTH dotted (`::ffff:10.0.0.1`) and hex
//     (`::ffff:a00:1`) forms — Node's URL parser produces hex.
//   - Permissive mode still blocks `localhost`/`0.0.0.0`.
//   - Tunnel exemption skips the check entirely.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertEgressAllowed, EgressBlockedError, isPrivateOrLoopback } from "./egress-guard.ts";

const PREV_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.EGRESS_GUARD;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env = { ...PREV_ENV };
});

describe("isPrivateOrLoopback", () => {
  test("blocks the full 127.0.0.0/8 loopback range, not just .1", () => {
    expect(isPrivateOrLoopback("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("127.255.255.254")).toBe(true);
    expect(isPrivateOrLoopback("127.42.42.42")).toBe(true);
  });

  test("blocks RFC 1918 ranges (10/8, 172.16-31/12, 192.168/16)", () => {
    expect(isPrivateOrLoopback("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("10.255.255.255")).toBe(true);
    expect(isPrivateOrLoopback("172.16.5.5")).toBe(true);
    expect(isPrivateOrLoopback("172.31.255.254")).toBe(true);
    expect(isPrivateOrLoopback("192.168.1.1")).toBe(true);
  });

  test("does NOT block 172.x.x.x outside the 16-31 second-octet range", () => {
    expect(isPrivateOrLoopback("172.15.0.1")).toBe(false);
    expect(isPrivateOrLoopback("172.32.0.1")).toBe(false);
  });

  test("blocks 169.254.169.254 (AWS EC2 metadata, the canonical SSRF target)", () => {
    expect(isPrivateOrLoopback("169.254.169.254")).toBe(true);
    expect(isPrivateOrLoopback("169.254.0.1")).toBe(true);
  });

  test("blocks unspecified addresses (0.0.0.0, ::)", () => {
    expect(isPrivateOrLoopback("0.0.0.0")).toBe(true);
    expect(isPrivateOrLoopback("::")).toBe(true);
  });

  test("blocks IPv6 loopback, unique-local, and link-local", () => {
    expect(isPrivateOrLoopback("::1")).toBe(true);
    expect(isPrivateOrLoopback("fc00::1")).toBe(true);
    expect(isPrivateOrLoopback("fd00::1")).toBe(true);
    expect(isPrivateOrLoopback("fe80::1")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 in both decimal and hex forms", () => {
    // ::ffff:10.0.0.1 — decimal form, the input shape.
    expect(isPrivateOrLoopback("::ffff:10.0.0.1")).toBe(true);
    // ::ffff:a00:1 — Node's URL parser normalises ::ffff:10.0.0.1 to this.
    expect(isPrivateOrLoopback("::ffff:a00:1")).toBe(true);
    // ::ffff:c0a8:0101 → 192.168.1.1
    expect(isPrivateOrLoopback("::ffff:c0a8:101")).toBe(true);
    // ::ffff:7f00:1 → 127.0.0.1
    expect(isPrivateOrLoopback("::ffff:7f00:1")).toBe(true);
  });

  test("blocks suspicious hostnames", () => {
    expect(isPrivateOrLoopback("localhost")).toBe(true);
    expect(isPrivateOrLoopback("foo.local")).toBe(true);
    expect(isPrivateOrLoopback("bar.internal")).toBe(true);
  });

  test("allows public IPs and hostnames", () => {
    expect(isPrivateOrLoopback("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopback("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopback("api.example.com")).toBe(false);
    expect(isPrivateOrLoopback("2001:db8::1")).toBe(false);
  });
});

describe("assertEgressAllowed (strict mode)", () => {
  test("throws EgressBlockedError on every banned IPv4", () => {
    const banned = [
      "10.0.0.1",
      "172.16.5.5",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "127.0.0.1",
      "127.255.255.254",
      "0.0.0.0",
    ];
    for (const ip of banned) {
      expect(() => assertEgressAllowed(`http://${ip}/probe`, { mode: "strict" })).toThrow(
        EgressBlockedError,
      );
    }
  });

  test("throws on every banned IPv6", () => {
    const banned = [
      "[::1]",
      "[fc00::1]",
      "[fd00::1]",
      "[fe80::1]",
      "[::ffff:10.0.0.1]",
      "[::ffff:a00:1]",
    ];
    for (const ip of banned) {
      expect(() => assertEgressAllowed(`http://${ip}/probe`, { mode: "strict" })).toThrow(
        EgressBlockedError,
      );
    }
  });

  test("throws on suspicious hostnames", () => {
    expect(() => assertEgressAllowed("http://localhost/probe", { mode: "strict" })).toThrow(
      EgressBlockedError,
    );
    expect(() => assertEgressAllowed("http://foo.local/probe", { mode: "strict" })).toThrow(
      EgressBlockedError,
    );
    expect(() => assertEgressAllowed("http://bar.internal/probe", { mode: "strict" })).toThrow(
      EgressBlockedError,
    );
  });

  test("allows public targets in strict mode", () => {
    expect(() => assertEgressAllowed("https://8.8.8.8/probe", { mode: "strict" })).not.toThrow();
    expect(() =>
      assertEgressAllowed("https://api.example.com/v1", { mode: "strict" }),
    ).not.toThrow();
    expect(() =>
      assertEgressAllowed("https://[2001:db8::1]/probe", { mode: "strict" }),
    ).not.toThrow();
  });

  test("error carries reason + host", () => {
    try {
      assertEgressAllowed("http://10.0.0.1/probe", { mode: "strict" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EgressBlockedError);
      expect((err as EgressBlockedError).code).toBe("egress_blocked");
      expect((err as EgressBlockedError).reason).toBe("private_ip_blocked");
      expect((err as EgressBlockedError).host).toBe("10.0.0.1");
    }
  });
});

describe("assertEgressAllowed (permissive mode)", () => {
  test("allows RFC 1918 + link-local (developer convenience)", () => {
    expect(() => assertEgressAllowed("http://10.0.0.1/x", { mode: "permissive" })).not.toThrow();
    expect(() => assertEgressAllowed("http://192.168.1.1/x", { mode: "permissive" })).not.toThrow();
    expect(() =>
      assertEgressAllowed("http://169.254.169.254/x", { mode: "permissive" }),
    ).not.toThrow();
    expect(() =>
      assertEgressAllowed("http://127.0.0.1:8080/x", { mode: "permissive" }),
    ).not.toThrow();
  });

  test("still blocks bare localhost and 0.0.0.0 (gate is non-trivial)", () => {
    expect(() => assertEgressAllowed("http://localhost/x", { mode: "permissive" })).toThrow(
      EgressBlockedError,
    );
    expect(() => assertEgressAllowed("http://0.0.0.0/x", { mode: "permissive" })).toThrow(
      EgressBlockedError,
    );
  });
});

describe("assertEgressAllowed (tunnel exemption)", () => {
  test("tunnel_target skips the entire check, even for the AWS metadata endpoint", () => {
    expect(() =>
      assertEgressAllowed("http://169.254.169.254/latest/meta-data/", {
        mode: "strict",
        tunnel_target: "agent-1",
      }),
    ).not.toThrow();
    expect(() =>
      assertEgressAllowed("http://10.0.0.1/internal", {
        mode: "strict",
        tunnel_target: "agent-1",
      }),
    ).not.toThrow();
    expect(() =>
      assertEgressAllowed("http://[fc00::1]/x", {
        mode: "strict",
        tunnel_target: "agent-1",
      }),
    ).not.toThrow();
  });

  test("empty / null tunnel_target falls through to the normal check", () => {
    expect(() =>
      assertEgressAllowed("http://10.0.0.1/x", {
        mode: "strict",
        tunnel_target: "",
      }),
    ).toThrow(EgressBlockedError);
    expect(() =>
      assertEgressAllowed("http://10.0.0.1/x", {
        mode: "strict",
        tunnel_target: null,
      }),
    ).toThrow(EgressBlockedError);
  });
});

describe("assertEgressAllowed (mode resolution)", () => {
  test("explicit ctx.mode wins over env vars", () => {
    process.env.EGRESS_GUARD = "permissive";
    expect(() => assertEgressAllowed("http://10.0.0.1/x", { mode: "strict" })).toThrow(
      EgressBlockedError,
    );
  });

  test("EGRESS_GUARD=strict env var triggers strict mode", () => {
    process.env.EGRESS_GUARD = "strict";
    expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).toThrow(EgressBlockedError);
  });

  test("NODE_ENV=production defaults to strict", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).toThrow(EgressBlockedError);
  });

  test("development default is permissive (allows 10.x)", () => {
    process.env.NODE_ENV = "development";
    expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).not.toThrow();
  });
});
