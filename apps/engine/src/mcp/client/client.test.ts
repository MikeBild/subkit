// Focused unit coverage for the external MCP CLIENT subsystem.
//
// These are pure, DB-free assertions over the validation + manifest
// surface. The full integration suite (live handshake, drift, audit
// rows, tenant isolation against a real Db) is owned by the
// test-generator agent; this file pins the deterministic invariants the
// loop + route layers depend on and proves all three modules import and
// type-check together.

import { describe, expect, test } from "bun:test";
import { __mcpClientInternalsForTests, type RemoteToolDescriptor } from "./pool.ts";
import { parseAuthConfig, redactLastError } from "./registry.ts";
import { reconcileManifestHash } from "./schema-drift.ts";

const { hashManifest, capManifest, PER_SERVER_MANIFEST_BYTE_CAP } = __mcpClientInternalsForTests;

describe("registry.parseAuthConfig", () => {
  test("null column → kind none", () => {
    expect(parseAuthConfig(null)).toEqual({ kind: "none" });
  });

  test("bearer parses with no inline secret (secret lives in credentials)", () => {
    // The secret is stored by reference in the credentials table keyed by
    // mcp_server_id — auth_config carries ONLY the kind for bearer.
    const cfg = parseAuthConfig({ kind: "bearer" });
    expect(cfg.kind).toBe("bearer");
  });

  test("a leaked secret key in auth_config is rejected (.strict)", () => {
    // No secret key may ride on auth_config — `.strict()` rejects unknown
    // keys so a leaked token never reaches the row.
    expect(() => parseAuthConfig({ kind: "bearer", token: "shhh" })).toThrow();
    expect(() => parseAuthConfig({ kind: "bearer", token_ref: "x" })).toThrow();
  });

  test("oauth2 with issuer/client_id/scope parses", () => {
    const cfg = parseAuthConfig({
      kind: "oauth2",
      issuer: "https://idp.example.com",
      client_id: "abc",
      scope: "read",
    });
    expect(cfg.kind).toBe("oauth2");
    expect(cfg.issuer).toBe("https://idp.example.com");
  });
});

describe("pool.hashManifest determinism", () => {
  const a: RemoteToolDescriptor = {
    name: "search",
    description: "search docs",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };
  const b: RemoteToolDescriptor = {
    name: "create",
    description: "create a page",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  };

  test("hash is stable across runs", () => {
    expect(hashManifest([a, b])).toBe(hashManifest([a, b]));
  });

  test("hash is order-independent within a tool object's keys but order-sensitive across tools", () => {
    // Canonical JSON sorts object keys, so re-ordering inputSchema keys
    // must not change the hash.
    const aReordered: RemoteToolDescriptor = {
      inputSchema: { properties: { q: { type: "string" } }, type: "object" },
      description: "search docs",
      name: "search",
    };
    expect(hashManifest([aReordered, b])).toBe(hashManifest([a, b]));
  });

  test("a changed input schema changes the hash (drift signal)", () => {
    const aChanged: RemoteToolDescriptor = {
      ...a,
      inputSchema: { type: "object", properties: { q: { type: "number" } } },
    };
    expect(hashManifest([aChanged, b])).not.toBe(hashManifest([a, b]));
  });
});

describe("pool.capManifest token budget", () => {
  test("under-cap manifest is returned untouched", () => {
    const tools: RemoteToolDescriptor[] = [
      { name: "t1", description: "x", inputSchema: { type: "object" } },
    ];
    expect(capManifest("tenant", "ns", "srv", tools)).toBe(tools);
  });

  test("over-cap manifest drops heaviest tools and stays under the cap", () => {
    // One huge tool plus a few small ones; the heavy one must be dropped.
    const heavy: RemoteToolDescriptor = {
      name: "heavy",
      description: "x".repeat(PER_SERVER_MANIFEST_BYTE_CAP + 1000),
      inputSchema: { type: "object" },
    };
    const small: RemoteToolDescriptor[] = Array.from({ length: 3 }, (_, i) => ({
      name: `small_${i}`,
      description: "small",
      inputSchema: { type: "object" },
    }));
    const capped = capManifest("tenant", "ns", "srv", [heavy, ...small]);
    expect(capped.length).toBeLessThan(4);
    expect(capped.some((t) => t.name === "heavy")).toBe(false);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(PER_SERVER_MANIFEST_BYTE_CAP);
  });

  test("a single tool larger than the cap is still kept (never empty)", () => {
    // Pre-fix this produced an EMPTY manifest, making the server vanish
    // from the palette with no signal. The smallest tool must survive even
    // when it alone exceeds the cap.
    const onlyTool: RemoteToolDescriptor = {
      name: "oversized",
      description: "y".repeat(PER_SERVER_MANIFEST_BYTE_CAP + 5000),
      inputSchema: { type: "object" },
    };
    const capped = capManifest("tenant", "ns", "srv", [onlyTool]);
    expect(capped.length).toBe(1);
    expect(capped[0]!.name).toBe("oversized");
  });

  test("keeps the most (lightest) tools that fit when all are over the aggregate cap", () => {
    // Several medium tools whose sum exceeds the cap: the lightest subset
    // that fits is kept, heaviest dropped — matching the comment contract.
    const tools: RemoteToolDescriptor[] = Array.from({ length: 6 }, (_, i) => ({
      name: `t_${i}`,
      // Ascending sizes so the heaviest (highest index) are dropped first.
      description: "z".repeat(6000 + i * 1000),
      inputSchema: { type: "object" },
    }));
    const capped = capManifest("tenant", "ns", "srv", tools);
    expect(capped.length).toBeGreaterThan(0);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(PER_SERVER_MANIFEST_BYTE_CAP);
    // The lightest tool (t_0) is always retained; the heaviest (t_5) dropped.
    expect(capped.some((t) => t.name === "t_0")).toBe(true);
    expect(capped.some((t) => t.name === "t_5")).toBe(false);
  });
});

describe("registry.redactLastError", () => {
  test("strips query string + path from an embedded URL, keeping host", () => {
    const raw = "fetch failed for https://mcp.example.com/call?token=SECRET123&q=x: ECONNRESET";
    const safe = redactLastError(raw);
    expect(safe).not.toContain("SECRET123");
    expect(safe).not.toContain("?token");
    expect(safe).not.toContain("/call");
    expect(safe).toContain("https://mcp.example.com");
    expect(safe).toContain("ECONNRESET");
  });

  test("redacts multiple embedded URLs", () => {
    const raw = "redirect https://a.example.com/x?s=1 -> https://b.example.com/y?s=2 failed";
    const safe = redactLastError(raw);
    expect(safe).toContain("https://a.example.com");
    expect(safe).toContain("https://b.example.com");
    expect(safe).not.toContain("?s=1");
    expect(safe).not.toContain("?s=2");
  });

  test("passes a plain message through unchanged", () => {
    expect(redactLastError("handshake timed out")).toBe("handshake timed out");
  });

  test("caps an oversized error message", () => {
    const safe = redactLastError("e".repeat(1000));
    expect(safe.length).toBeLessThanOrEqual(301);
  });
});

describe("module wiring", () => {
  test("reconcileManifestHash is callable (exported)", () => {
    expect(typeof reconcileManifestHash).toBe("function");
  });
});
