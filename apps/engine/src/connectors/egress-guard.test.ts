import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Executor } from "../db/client.ts";
import { replaceTestEnv, testEnv } from "../test-helpers/determinism/env.ts";
import {
  _withEgressTenantOriginForTests,
  assertEgressAllowed,
  assertEgressAllowedResolved,
  EgressBlockedError,
  isPrivateOrLoopback,
} from "./egress-guard.ts";

const originOverrideExec = {} as Executor;

test("persisted self-service origin overrides permissive mode without hosted feature flags", async () => {
  await _withEgressTenantOriginForTests(
    async () => "self_service",
    async () => {
      await expect(
        assertEgressAllowedResolved("https://10.0.0.1/", {
          tenant_id: "self-service-fixture",
          exec: originOverrideExec,
          mode: "permissive",
        }),
      ).rejects.toThrow("private_ip_blocked");
    },
  );
});

test("persisted self-hosted origin retains explicit private connection policy", async () => {
  await _withEgressTenantOriginForTests(
    async () => "self_hosted",
    async () => {
      await expect(
        assertEgressAllowedResolved("https://10.0.0.1/", {
          tenant_id: "self-hosted-fixture",
          exec: originOverrideExec,
          mode: "permissive",
        }),
      ).resolves.toBeUndefined();
    },
  );
});

test("tenant origin lookup failures and missing tenants fail closed", async () => {
  for (const reader of [
    async () => null,
    async () => {
      throw new Error("unavailable");
    },
  ]) {
    await _withEgressTenantOriginForTests(reader, async () => {
      await expect(
        assertEgressAllowedResolved("https://93.184.216.34/", {
          tenant_id: "missing-fixture",
          exec: originOverrideExec,
          mode: "permissive",
        }),
      ).rejects.toThrow("tenant_context_unavailable");
    });
  }
});

// biome-ignore lint/suspicious/noExplicitAny: test stub for node's dns lookup
type LookupStub = any;
function fakeLookup(address: string): LookupStub {
  return async () => [{ address, family: address.includes(":") ? 6 : 4 }];
}

const PREV_ENV = { ...testEnv };

beforeEach(() => {
  delete testEnv.EGRESS_GUARD;
  delete testEnv.NODE_ENV;
});

afterEach(() => {
  replaceTestEnv(PREV_ENV);
});

describe("isPrivateOrLoopback", () => {
  test("blocks the complete local-use translation prefix after IPv6 normalization", async () => {
    for (const host of [
      "64:ff9b:1::a9fe:a9fe",
      "0064:ff9b:0001:ffff:ffff:ffff:ffff:ffff",
      "64:ff9b:1::",
    ]) {
      expect(isPrivateOrLoopback(host)).toBe(true);
      expect(() => assertEgressAllowed(`https://[${host}]/`, { mode: "strict" })).toThrow(
        EgressBlockedError,
      );
      await expect(
        assertEgressAllowedResolved(
          "https://translated.example.test/",
          { mode: "strict" },
          { lookupImpl: fakeLookup(host) },
        ),
      ).rejects.toThrow(EgressBlockedError);
    }
    expect(isPrivateOrLoopback("64:ff9b:2::1")).toBe(false);
  });
  test("blocks local DNS names with a terminal root dot", () => {
    for (const host of ["localhost.", "metadata.local.", "database.internal."]) {
      expect(isPrivateOrLoopback(host)).toBe(true);
      expect(() => assertEgressAllowed(`https://${host}/`, { mode: "strict" })).toThrow(
        EgressBlockedError,
      );
    }
  });

  test("normalizes expanded IPv6 before classifying loopback and mapped private addresses", () => {
    for (const host of ["0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:0:0:0"]) {
      expect(isPrivateOrLoopback(host)).toBe(true);
    }
  });

  test("blocks shared, benchmarking, multicast and reserved address space", () => {
    for (const host of [
      "0.1.2.3",
      "100.64.0.1",
      "100.127.255.254",
      "198.18.0.1",
      "198.19.255.254",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "fec0::1",
      "ff02::1",
    ]) {
      expect(isPrivateOrLoopback(host)).toBe(true);
    }
    for (const host of ["100.63.255.254", "100.128.0.1", "198.17.255.254", "198.20.0.1"]) {
      expect(isPrivateOrLoopback(host)).toBe(false);
    }
  });

  test("keeps private self-hosted destinations available in explicit permissive mode", () => {
    for (const host of ["100.64.0.1", "198.18.0.1", "database.internal."]) {
      expect(() => assertEgressAllowed(`https://${host}/`, { mode: "permissive" })).not.toThrow();
    }
  });

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
    expect(isPrivateOrLoopback("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("::ffff:a00:1")).toBe(true);
    expect(isPrivateOrLoopback("::ffff:c0a8:101")).toBe(true);
    expect(isPrivateOrLoopback("::ffff:7f00:1")).toBe(true);
  });

  test("blocks private IPv4 embedded in IPv4-compatible and well-known NAT64 IPv6", () => {
    for (const host of [
      "::100",
      "::7f00:1",
      "::a9fe:a9fe",
      "::ffff:0:7f00:1",
      "::ffff:0:a9fe:a9fe",
      "64:ff9b::1",
      "64:ff9b::100",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::a00:1",
    ]) {
      expect(isPrivateOrLoopback(host)).toBe(true);
      expect(() => assertEgressAllowed(`https://[${host}]/`, { mode: "strict" })).toThrow(
        EgressBlockedError,
      );
    }
    expect(isPrivateOrLoopback("64:ff9b::808:808")).toBe(false);
  });

  test("blocks local-use and transition IPv6 destinations in strict mode", () => {
    for (const host of ["64:ff9b:1::1", "2002:808:808::1", "2001::1", "2001:0000:1234::1"]) {
      expect(isPrivateOrLoopback(host)).toBe(true);
      expect(() => assertEgressAllowed(`https://[${host}]/`, { mode: "strict" })).toThrow(
        EgressBlockedError,
      );
    }
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

describe("assertEgressAllowed (mode resolution)", () => {
  test("explicit ctx.mode wins over env vars", () => {
    testEnv.EGRESS_GUARD = "permissive";
    expect(() => assertEgressAllowed("http://10.0.0.1/x", { mode: "strict" })).toThrow(
      EgressBlockedError,
    );
  });

  test("egress.mode='strict' setConfigKey triggers strict mode (env-driven path retired in v3.5)", async () => {
    const { _resetConfigForTests, loadConfig, setConfigKey } = await import("../config/loader.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    _resetConfigForTests();
    const dir = mkdtempSync(join(tmpdir(), "sk-cfg-egress-"));
    try {
      await loadConfig({
        env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
        configPathOverride: join(dir, "subkit.config.json"),
      });
      await setConfigKey("egress.mode", "strict", { force: true });
      expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).toThrow(EgressBlockedError);
    } finally {
      _resetConfigForTests();
    }
  });

  test("NODE_ENV=production defaults to strict", () => {
    testEnv.NODE_ENV = "production";
    expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).toThrow(EgressBlockedError);
  });

  test("development default is permissive (allows 10.x)", () => {
    testEnv.NODE_ENV = "development";
    expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).not.toThrow();
  });
});

describe("assertEgressAllowedResolved — DNS resolution", () => {
  const strict = { mode: "strict" as const };

  test("blocks a public name that resolves to cloud-metadata (169.254.169.254)", async () => {
    await expect(
      assertEgressAllowedResolved("https://totally-legit.example.com/x", strict, {
        lookupImpl: fakeLookup("169.254.169.254"),
      }),
    ).rejects.toThrow(EgressBlockedError);
  });

  test("blocks a public name that resolves into RFC1918 space", async () => {
    await expect(
      assertEgressAllowedResolved("https://rebind.example.com/x", strict, {
        lookupImpl: fakeLookup("10.1.2.3"),
      }),
    ).rejects.toThrow(EgressBlockedError);
  });

  test("allows a public name that resolves to a public IP", async () => {
    await expect(
      assertEgressAllowedResolved("https://example.com/x", strict, {
        lookupImpl: fakeLookup("93.184.216.34"),
      }),
    ).resolves.toBeUndefined();
  });

  test("an IP literal is decided synchronously without a DNS lookup", async () => {
    let called = false;
    const spy: LookupStub = async () => {
      called = true;
      return [];
    };
    await assertEgressAllowedResolved("https://93.184.216.34/x", strict, { lookupImpl: spy });
    expect(called).toBe(false);
    await expect(
      assertEgressAllowedResolved("http://10.0.0.1/x", strict, { lookupImpl: spy }),
    ).rejects.toThrow(EgressBlockedError);
  });

  test("strict mode blocks DNS resolution failure before dispatch", async () => {
    const failing: LookupStub = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      assertEgressAllowedResolved("https://nxdomain.example/x", strict, { lookupImpl: failing }),
    ).rejects.toThrow("dns_resolution_failed");
  });

  test("strict mode blocks an empty DNS answer", async () => {
    await expect(
      assertEgressAllowedResolved("https://empty.example/x", strict, {
        lookupImpl: async () => [],
      }),
    ).rejects.toThrow("dns_resolution_failed");
  });

  test("permissive mode does not resolve private self-hosted names", async () => {
    let resolved = false;
    await assertEgressAllowedResolved(
      "https://database.internal/",
      { mode: "permissive" },
      {
        lookupImpl: async () => {
          resolved = true;
          throw new Error("unavailable resolver");
        },
      },
    );
    expect(resolved).toBe(false);
  });
});
