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

test("slug edge trimming preserves the previous normalization across Unicode inputs", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 0x10ffff }), { maxLength: 200 }), (points) => {
      const name = String.fromCodePoint(...points);
      const previous = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      expect(slugify(name)).toBe(previous);
    }),
    { seed: 20261109, numRuns: 1000 },
  );
});

test("metadata patches distinguish omitted fields from explicit acceptance and nulls", () => {
  expect(metadataPatchOf({ description: undefined, category: undefined })).toStrictEqual({});
  expect(metadataPatchOf({ accept_description: undefined })).toStrictEqual({});
  expect(metadataPatchOf({ accept_description: false })).toEqual({ accept_description: false });
  expect(metadataPatchOf({ accept_description: true, category: null })).toEqual({
    accept_description: true,
    category: null,
  });
  expect(templateWasRebound("old", undefined, false)).toBe(false);
  expect(templateWasRebound("old", null, undefined)).toBe(false);
});

test("OAuth scope and MCP trust ignore primitive or callable configuration blocks", () => {
  const callable = Object.assign(() => undefined, { scope: "read" });
  for (const config of [undefined, false, 1, "config", callable]) {
    expect(oauthScopeOf(config)).toBeNull();
    expect(mcpTrustedTools(config)).toEqual([]);
  }
  for (const oauth of [undefined, null, false, 1, callable]) {
    expect(oauthScopeOf({ oauth })).toBeNull();
  }
  expect(oauthScopeOf(Object.assign(() => undefined, { oauth: { scope: "read" } }))).toBeNull();
  expect(oauthScopeOf({ oauth: { scope: 42 } })).toBeNull();
  const tools = { tools_without_confirmation: ["read"] };
  const arrayBlock = Object.assign([], tools);
  const callableBlock = Object.assign(() => undefined, tools);
  expect(mcpTrustedTools(Object.assign(() => undefined, { mcp: tools }))).toEqual([]);
  for (const mcp of [undefined, null, false, 1, "mcp", arrayBlock, callableBlock]) {
    expect(mcpTrustedTools({ mcp })).toEqual([]);
  }
  expect(mcpTrustedTools({ mcp: { tools_without_confirmation: "read" } })).toEqual([]);
});

test("MCP trust survives a missing incoming block and preserves an empty trust state", () => {
  const prior = { mcp: { tools_without_confirmation: ["read"] } };
  const next = { display: "renamed" };
  expect(decideMcpTrustCarryOver("mcp", prior, next)).toEqual({
    kind: "accepted",
    config: { display: "renamed", mcp: { tools_without_confirmation: ["read"] } },
  });
  expect(decideMcpTrustCarryOver("mcp", {}, next)).toEqual({ kind: "accepted", config: next });
  expect(
    decideMcpTrustCarryOver("mcp", prior, { mcp: { tools_without_confirmation: [] } }),
  ).toEqual({ kind: "rejected" });
});

test("half-open circuits admit probes even while the previous opening is recent", () => {
  expect(
    isCircuitOpenBlocking(
      { circuit_state: "half-open", circuit_opened_at: new Date(10), circuit_reset_ms: 100 },
      11,
    ),
  ).toBe(false);
});
