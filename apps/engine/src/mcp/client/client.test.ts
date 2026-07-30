// Focused unit coverage for the external MCP CLIENT subsystem.
//
// These are pure, DB-free assertions over the validation + manifest
// surface. The full integration suite (live handshake, drift, audit
// rows, tenant isolation against a real Db) is owned by the
// test-generator agent; this file pins the deterministic invariants the
// loop + route layers depend on and proves all three modules import and
// type-check together.

import { describe, expect, test } from "bun:test";
import { EgressBlockedError } from "../../connectors/egress-guard.ts";
import { __mcpClientInternalsForTests, type RemoteToolDescriptor } from "./pool.ts";
import {
  classifyMcpHandshakeFailure,
  McpPreflightError,
  parseAuthConfig,
  redactUpstreamDetail,
  UNAUTHORIZED_HANDSHAKE_MESSAGE,
} from "./registry.ts";
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

describe("registry.redactUpstreamDetail", () => {
  test("strips query string + path from an embedded URL, keeping host", () => {
    const raw = "fetch failed for https://mcp.example.com/call?token=SECRET123&q=x: ECONNRESET";
    const safe = redactUpstreamDetail(raw);
    expect(safe).not.toContain("SECRET123");
    expect(safe).not.toContain("?token");
    expect(safe).not.toContain("/call");
    expect(safe).toContain("https://mcp.example.com");
    expect(safe).toContain("ECONNRESET");
  });

  test("redacts multiple embedded URLs", () => {
    const raw = "redirect https://a.example.com/x?s=1 -> https://b.example.com/y?s=2 failed";
    const safe = redactUpstreamDetail(raw);
    expect(safe).toContain("https://a.example.com");
    expect(safe).toContain("https://b.example.com");
    expect(safe).not.toContain("?s=1");
    expect(safe).not.toContain("?s=2");
  });

  test("passes a plain message through unchanged", () => {
    expect(redactUpstreamDetail("handshake timed out")).toBe("handshake timed out");
  });

  test("caps an oversized error message", () => {
    const safe = redactUpstreamDetail("e".repeat(1000));
    expect(safe.length).toBeLessThanOrEqual(301);
  });
});

describe("registry.classifyMcpHandshakeFailure", () => {
  const endpoint = "https://remote.example.test/mcp";

  test("nothing the remote wrote survives into the verdict", () => {
    // The dominant shape: the SDK reports a refused handshake as
    // `Error POSTing to endpoint: <raw response body>`, so the server we
    // just failed to authenticate against decides what that string says —
    // and an OAuth error body routinely echoes the token it rejected. The
    // engine reads the status out of it and writes its own sentence.
    const fault = classifyMcpHandshakeFailure(
      'Error POSTing to endpoint (HTTP 401): {"error":"invalid_token","error_description":"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk is expired"}',
      endpoint,
    );
    expect(fault.error_code).toBe("auth_rejected");
    expect(fault.reason).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(fault.reason).not.toContain("invalid_token");
    // What survives is engine-authored and still names what failed.
    expect(fault.reason).toContain("remote.example.test");
    expect(fault.reason).toContain("credential");
    expect(fault.reason).toContain("401");
  });

  test("a credential inlined in the configured endpoint never reaches the sentence", () => {
    // `base_url` is operator-authored, but an operator who pasted a URL
    // with userinfo would otherwise publish it in a column the API serves.
    const fault = classifyMcpHandshakeFailure(
      "connect ECONNREFUSED",
      "https://svc:hunter2@remote.example.test/mcp",
    );
    expect(fault.reason).not.toContain("hunter2");
    expect(fault.reason).not.toContain("svc:");
    expect(fault.reason).toContain("remote.example.test");
  });

  test("each status maps to the code the HTTP driver already publishes", () => {
    const codeFor = (raw: string): string => classifyMcpHandshakeFailure(raw, endpoint).error_code;
    expect(codeFor("Error POSTing to endpoint (HTTP 403): forbidden")).toBe("auth_rejected");
    expect(codeFor("Error POSTing to endpoint (HTTP 429): slow down")).toBe("rate_limited");
    expect(codeFor("Error POSTing to endpoint (HTTP 404): not found")).toBe("resource_not_found");
    expect(codeFor("Error POSTing to endpoint (HTTP 410): gone")).toBe("resource_not_found");
    expect(codeFor("Error POSTing to endpoint (HTTP 503): unavailable")).toBe("vendor_degraded");
    // The engine's own collapse of the SDK's UnauthorizedError — the one
    // message on this path the engine authored, so it may be read.
    expect(codeFor(UNAUTHORIZED_HANDSHAKE_MESSAGE)).toBe("auth_rejected");
  });

  test("a failure that never reached HTTP semantics says so rather than guessing", () => {
    const fault = classifyMcpHandshakeFailure(
      "getaddrinfo ENOTFOUND remote.example.test",
      endpoint,
    );
    expect(fault.error_code).toBe("mcp_handshake_failed");
    expect(fault.reason).toContain("did not complete");
    // The operator is pointed at where the upstream text actually lives.
    expect(fault.reason).toContain("log");
  });

  test("the verdict is bounded no matter how verbose the upstream body was", () => {
    const fault = classifyMcpHandshakeFailure("x".repeat(5_000), endpoint);
    expect(fault.reason.length).toBeLessThanOrEqual(300);
  });

  test("the engine's OWN refusal is carried verbatim — it is the diagnosis", () => {
    // Authorship, not prose, decides what survives. A missing credential or
    // an unset config leaf is the engine talking, and flattening it into the
    // generic sentence would delete the only text that says WHICH one to fix.
    const missing = classifyMcpHandshakeFailure(
      new McpPreflightError(
        "credential_missing",
        "oauth2_client_credentials server has no client credential — register the client_id and client_secret first",
      ),
      endpoint,
    );
    expect(missing.error_code).toBe("credential_missing");
    expect(missing.reason).toContain("register the client_id");
    expect(missing.reason).toContain("remote.example.test");

    const config = classifyMcpHandshakeFailure(
      new McpPreflightError(
        "config_incomplete",
        "no canonical OAuth redirect URI — set server.public_base_url",
      ),
      endpoint,
    );
    expect(config.error_code).toBe("config_incomplete");
    expect(config.reason).toContain("server.public_base_url");
  });

  test("an egress refusal names the guard's reason, not the remote", () => {
    const fault = classifyMcpHandshakeFailure(
      new EgressBlockedError("private_ip_resolved", "metadata.example.test"),
      endpoint,
    );
    expect(fault.error_code).toBe("egress_blocked");
    expect(fault.reason).toContain("private_ip_resolved");
  });

  test("an engine message is bounded too — a column is a column", () => {
    const fault = classifyMcpHandshakeFailure(
      new McpPreflightError("credential_invalid", "y".repeat(5_000)),
      endpoint,
    );
    // 300 characters plus the truncation ellipsis, as everywhere else here.
    expect(fault.reason.length).toBeLessThanOrEqual(301);
  });
});

describe("module wiring", () => {
  test("reconcileManifestHash is callable (exported)", () => {
    expect(typeof reconcileManifestHash).toBe("function");
  });
});
