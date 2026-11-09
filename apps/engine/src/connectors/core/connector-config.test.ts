import { expect, test } from "bun:test";
import fc from "fast-check";
import { validateConnectorAuthType, validateMcpAuthConsistency } from "./config-policy.ts";
import {
  authTypeIssue,
  connectorEnvironmentKey,
  decideMcpTrustCarryOver,
  isCircuitOpenBlocking,
  mcpAuthConsistencyIssue,
  mcpTrustedTools,
  metadataPatchOf,
  oauthScopeOf,
  signedJwtAuthConfigIssue,
  slugify,
  templateWasRebound,
} from "./connector-config.ts";

test("driver, MCP and signed-JWT policy facts preserve the validation matrix", () => {
  expect(authTypeIssue("http", "signed_jwt")).toBeNull();
  expect(authTypeIssue("postgres", "signed_jwt")).toMatchObject({ path: "auth_type" });
  expect(authTypeIssue("http", "oauth2_client")).toMatchObject({ path: "auth_type" });
  expect(authTypeIssue("mcp", "oauth2_client")).toBeNull();
  expect(
    mcpAuthConsistencyIssue("mcp", "bearer", {
      mcp: { transport: "http", auth: { kind: "basic" } },
    }),
  ).toMatchObject({ path: "config.mcp.auth.kind" });
  expect(
    mcpAuthConsistencyIssue("mcp", "bearer", {
      mcp: { transport: "http", auth: { kind: "bearer" } },
    }),
  ).toBeNull();
  expect(mcpAuthConsistencyIssue("http", "bearer", {})).toBeNull();
  expect(signedJwtAuthConfigIssue("none", {})).toBeNull();
  expect(signedJwtAuthConfigIssue("signed_jwt", { oauth: {} })).toMatchObject({
    path: "config.signed_jwt",
  });
  expect(
    signedJwtAuthConfigIssue("signed_jwt", {
      signed_jwt: { algorithm: "ES256", audience: "api", issuer: "issuer" },
    }),
  ).toBeNull();
});

test("configuration policy rejects each unsupported transport and malformed MCP shape", () => {
  expect(validateConnectorAuthType("mcp", "signed_jwt")).toEqual([
    expect.objectContaining({ path: "auth_type" }),
  ]);
  expect(validateMcpAuthConsistency("mcp", "bearer", undefined)).toEqual([
    expect.objectContaining({ path: "config.mcp" }),
  ]);
  expect(validateMcpAuthConsistency("mcp", "bearer", { mcp: [] })).toEqual([
    expect.objectContaining({ path: "config.mcp" }),
  ]);
  expect(validateMcpAuthConsistency("mcp", "bearer", { mcp: {} })).toEqual([
    expect.objectContaining({ path: "config.mcp.auth.kind" }),
  ]);
  expect(validateMcpAuthConsistency("mcp", "bearer", { mcp: { auth: [] } })).toEqual([
    expect.objectContaining({ path: "config.mcp.auth.kind" }),
  ]);
});

test("deterministic connector facts preserve slug, metadata, circuit, key and OAuth behavior", () => {
  expect(slugify("  Daily / API!!! ")).toBe("daily-api");
  expect(slugify("Ä")).toBe("");
  expect(slugify("a".repeat(80))).toHaveLength(64);
  expect(metadataPatchOf({ description: null, category: "ops" })).toEqual({
    description: null,
    category: "ops",
  });
  expect(metadataPatchOf({})).toEqual({});
  expect(
    isCircuitOpenBlocking(
      { circuit_state: "closed", circuit_opened_at: null, circuit_reset_ms: 2 },
      5,
    ),
  ).toBe(false);
  expect(
    isCircuitOpenBlocking(
      { circuit_state: "open", circuit_opened_at: null, circuit_reset_ms: 2 },
      5,
    ),
  ).toBe(false);
  expect(
    isCircuitOpenBlocking(
      { circuit_state: "open", circuit_opened_at: new Date(10), circuit_reset_ms: 20 },
      29,
    ),
  ).toBe(true);
  expect(
    isCircuitOpenBlocking(
      { circuit_state: "open", circuit_opened_at: new Date(10), circuit_reset_ms: 20 },
      30,
    ),
  ).toBe(false);
  expect(connectorEnvironmentKey("connector", "prod")).toBe("connector:prod");
  expect(oauthScopeOf(null)).toBeNull();
  expect(oauthScopeOf({ oauth: "wrong" })).toBeNull();
  expect(oauthScopeOf({ oauth: { scope: "  read write  " } })).toBe("read write");
  expect(oauthScopeOf({ oauth: { scope: " " } })).toBeNull();
  expect(templateWasRebound("old", "new", false)).toBe(true);
  expect(templateWasRebound("old", "old", false)).toBe(false);
  expect(templateWasRebound("old", undefined, true)).toBe(true);
});

test("MCP trust carry-over is a pure accept-or-reject decision and leaves facts unchanged", () => {
  const prior = Object.freeze({ mcp: Object.freeze({ tools_without_confirmation: ["b", "a"] }) });
  const next = Object.freeze({ mcp: Object.freeze({ transport: "sse" }) });
  const before = JSON.stringify({ prior, next });
  expect(mcpTrustedTools({ mcp: { tools_without_confirmation: ["b", "a", "b", 1] } })).toEqual([
    "a",
    "b",
  ]);
  expect(mcpTrustedTools(null)).toEqual([]);
  expect(decideMcpTrustCarryOver("http", prior, next)).toEqual({ kind: "accepted", config: next });
  expect(decideMcpTrustCarryOver("mcp", prior, undefined)).toEqual({
    kind: "accepted",
    config: undefined,
  });
  expect(decideMcpTrustCarryOver("mcp", prior, next)).toEqual({
    kind: "accepted",
    config: { mcp: { transport: "sse", tools_without_confirmation: ["a", "b"] } },
  });
  expect(
    decideMcpTrustCarryOver("mcp", prior, {
      mcp: { tools_without_confirmation: ["b", "a"] },
    }),
  ).toEqual({
    kind: "accepted",
    config: { mcp: { tools_without_confirmation: ["b", "a"] } },
  });
  expect(
    decideMcpTrustCarryOver("mcp", prior, {
      mcp: { tools_without_confirmation: ["a", "different"] },
    }),
  ).toEqual({ kind: "rejected" });
  expect(JSON.stringify({ prior, next })).toBe(before);
});

test("slug normalization is deterministic for frozen inputs", () => {
  fc.assert(
    fc.property(fc.string(), (name) => {
      const frozen = Object.freeze(name);
      const value = slugify(frozen);
      expect(value.length).toBeLessThanOrEqual(64);
      expect(slugify(value)).toBe(value);
      expect(frozen).toBe(name);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
