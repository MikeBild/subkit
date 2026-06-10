// Audit-contract guard + writer tests for the external-MCP-client
// feature (#171).
//
// The `mcp_server.*` action constants were reserved under #166 W2 so
// the writer could not mint free-string action values. With #171 the
// recorders that emit each action land in
// `apps/engine/src/audit/recorders/mcp-server.ts`; this file asserts:
//
//   1. the reserved action-string constants still hold their values
//      (a future cleanup that renamed one would silently break SIEM
//      queries built on the literal);
//   2. each recorder writes exactly its action string plus the key
//      metadata fields — round-tripped through the real audit write
//      path against a Postgres test DB;
//   3. no recorder ever lands a full URL, query string, token, or raw
//      byte count in metadata (only `url_host` + a coarse size bucket).
//
// `external_provider.*` constants stay reserved for the first opt-in,
// connector-shaped external-call writer (per-connector issues); their
// presence-check below fails-fast if a future cleanup removes them
// before a writer has switched to them.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { bucketSize } from "../buckets.ts";
import {
  AuditAction,
  recordMcpExternalToolInvoked,
  recordMcpExternalToolPaletteAssemblyFailed,
  recordMcpServerAuthorizationFailed,
  recordMcpServerAuthorizationStarted,
  recordMcpServerAuthorized,
  recordMcpServerConfigUpdated,
  recordMcpServerDeleted,
  recordMcpServerDisabled,
  recordMcpServerErrored,
  recordMcpServerHandshakeOk,
  recordMcpServerReEnabled,
  recordMcpServerRegistered,
} from "../index.ts";

const uuid = createDeterministicUuidFactory(0x171ab1);

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;

beforeAll(async () => {
  ctx = await createTestDb("mcp-writer-audit-contract");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "mcp-audit-t", display_name: "MCP Audit" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenant_id = t.id;
  actor_id = uuid();
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

/** Fetch the single audit row for a given action + resource_id. */
async function rowFor(action: string, resource_id: string) {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      tenant_id: auditLog.tenant_id,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resource_id, resource_id)));
  expect(rows.length).toBe(1);
  return rows[0]!;
}

describe("issue #166 W2 — reserved audit-action constants", () => {
  it("reserves the seven mcp_server.* constants", () => {
    expect(AuditAction.MCP_SERVER_REGISTERED).toBe("mcp_server.registered");
    expect(AuditAction.MCP_SERVER_CONFIG_UPDATED).toBe("mcp_server.config_updated");
    expect(AuditAction.MCP_SERVER_DISABLED).toBe("mcp_server.disabled");
    expect(AuditAction.MCP_SERVER_RE_ENABLED).toBe("mcp_server.re_enabled");
    expect(AuditAction.MCP_SERVER_ERRORED).toBe("mcp_server.errored");
    expect(AuditAction.MCP_SERVER_DELETED).toBe("mcp_server.deleted");
    expect(AuditAction.MCP_SERVER_HANDSHAKE_OK).toBe("mcp_server.handshake_ok");
  });

  it("reserves the mcp_external_tool.invoked constant", () => {
    expect(AuditAction.MCP_EXTERNAL_TOOL_INVOKED).toBe("mcp_external_tool.invoked");
  });

  it("reserves the mcp_external_tool.palette_assembly_failed constant (W5)", () => {
    expect(AuditAction.MCP_EXTERNAL_TOOL_PALETTE_ASSEMBLY_FAILED).toBe(
      "mcp_external_tool.palette_assembly_failed",
    );
  });

  it("reserves the three mcp_server.authorization* constants (#171 follow-up)", () => {
    expect(AuditAction.MCP_SERVER_AUTHORIZATION_STARTED).toBe("mcp_server.authorization_started");
    expect(AuditAction.MCP_SERVER_AUTHORIZED).toBe("mcp_server.authorized");
    expect(AuditAction.MCP_SERVER_AUTHORIZATION_FAILED).toBe("mcp_server.authorization_failed");
  });

  it("reserves the two external_provider.* constants", () => {
    expect(AuditAction.EXTERNAL_PROVIDER_CALL_SUCCEEDED).toBe("external_provider.call_succeeded");
    expect(AuditAction.EXTERNAL_PROVIDER_CALL_FAILED).toBe("external_provider.call_failed");
  });
});

describe("#171 — external MCP server audit writers", () => {
  it("recordMcpServerRegistered writes mcp_server.registered with host-only url", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerRegistered({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "notion",
      transport: "http",
      url_host: "https://notion-mcp.example.com/sse?token=SECRET123",
      request_source: "api",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.registered", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.tenant_id).toBe(tenant_id);
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.namespace).toBe("notion");
    expect(meta.transport).toBe("http");
    expect(meta.request_source).toBe("api");
    // Host-only — no scheme, path, query, or token leaked.
    expect(meta.url_host).toBe("notion-mcp.example.com");
    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain("SECRET123");
    expect(metaStr).not.toContain("token=");
    expect(metaStr).not.toContain("/sse");
  });

  it("recordMcpServerConfigUpdated writes mcp_server.config_updated with changed_fields + reason", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerConfigUpdated({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "github",
      changed_fields: ["url", "auth_config"],
      // Deliberately free of secret-keyword substrings — the audit
      // write path runs `scrubSecrets` over `reason`, so a phrase like
      // "bearer"/"token" would be redacted. The recorder itself never
      // carries the credential value (secret-by-reference).
      reason: "credential reference updated",
      request_source: "cli",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.config_updated", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("success");
    expect(row.reason).toBe("credential reference updated");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.changed_fields).toEqual(["url", "auth_config"]);
    expect(meta.request_source).toBe("cli");
  });

  it("recordMcpServerDisabled writes mcp_server.disabled", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerDisabled({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "vercel",
      request_source: "mcp",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.disabled", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("success");
    expect((row.metadata as Record<string, unknown>).namespace).toBe("vercel");
  });

  it("recordMcpServerReEnabled writes mcp_server.re_enabled", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerReEnabled({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "vercel",
      request_source: "mcp",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.re_enabled", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("success");
  });

  it("recordMcpServerErrored writes mcp_server.errored with result=error + reason=last_error", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerErrored({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "notion",
      last_error: "handshake timed out after 30s",
      request_source: "scheduler",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.errored", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("error");
    expect(row.reason).toBe("handshake timed out after 30s");
  });

  it("recordMcpServerDeleted writes mcp_server.deleted", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerDeleted({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "github",
      request_source: "api",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.deleted", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("success");
  });

  it("recordMcpServerHandshakeOk writes mcp_server.handshake_ok with tool_count + manifest_hash", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerHandshakeOk({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "notion",
      tool_count: 12,
      manifest_hash: "sha256:abcd1234",
      request_source: "scheduler",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.handshake_ok", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.tool_count).toBe(12);
    expect(meta.manifest_hash).toBe("sha256:abcd1234");
  });

  it("recordMcpExternalToolInvoked writes mcp_external_tool.invoked with a byte bucket, not raw bytes", async () => {
    const mcp_server_id = uuid();
    await recordMcpExternalToolInvoked({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "notion",
      remote_tool: "search_pages",
      outcome: "success",
      duration_ms: 842,
      byte_count: 2_000_000,
      request_source: "chat",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_external_tool.invoked", mcp_server_id);
    // Distinct resource_type so invocation volume aggregates apart from
    // the lifecycle configuration rows.
    expect(row.resource_type).toBe("mcp_external_tool");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.remote_tool).toBe("search_pages");
    expect(meta.outcome).toBe("success");
    expect(meta.duration_ms).toBe(842);
    // Coarse bucket, never the raw byte count. Bind to the live function so
    // a future bucket-boundary change keeps the assertion honest instead of
    // pinning a stale string literal.
    expect(meta.byte_count_bucket).toBe(bucketSize(2_000_000));
    expect(meta.byte_count).toBeUndefined();
  });

  it("recordMcpExternalToolInvoked maps an error outcome to result=error", async () => {
    const mcp_server_id = uuid();
    await recordMcpExternalToolInvoked({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "github",
      remote_tool: "create_issue",
      outcome: "error",
      duration_ms: 51,
      byte_count: 200,
      request_source: "chat",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_external_tool.invoked", mcp_server_id);
    expect(row.result).toBe("error");
    expect((row.metadata as Record<string, unknown>).byte_count_bucket).toBe(bucketSize(200));
  });

  it("recordMcpExternalToolPaletteAssemblyFailed writes palette_assembly_failed with result=error + reason (W5)", async () => {
    // resource_id is the tenant id (no single server to attribute to) — use
    // the seeded tenant so the row is queryable by it.
    await recordMcpExternalToolPaletteAssemblyFailed({
      tenant_id,
      actor_id,
      reason: "connectable-server enumeration failed",
      request_source: "chat",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_external_tool.palette_assembly_failed", tenant_id);
    expect(row.resource_type).toBe("mcp_external_tool");
    expect(row.result).toBe("error");
    expect(row.reason).toBe("connectable-server enumeration failed");
    expect((row.metadata as Record<string, unknown>).request_source).toBe("chat");
  });

  it("recordMcpServerAuthorizationStarted writes mcp_server.authorization_started with host-only issuer", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerAuthorizationStarted({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "rovo",
      issuer: "https://auth.atlassian.example.com/authorize?client_id=abc&state=SECRET456",
      request_source: "cli",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.authorization_started", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.namespace).toBe("rovo");
    expect(meta.request_source).toBe("cli");
    // Host-only — no scheme, path, query, or state leaked.
    expect(meta.issuer_host).toBe("auth.atlassian.example.com");
    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain("SECRET456");
    expect(metaStr).not.toContain("client_id=");
    expect(metaStr).not.toContain("/authorize");
  });

  it("recordMcpServerAuthorized writes mcp_server.authorized with host-only issuer", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerAuthorized({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "rovo",
      issuer: "https://auth.atlassian.example.com/token",
      request_source: "api",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.authorized", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.namespace).toBe("rovo");
    expect(meta.issuer_host).toBe("auth.atlassian.example.com");
    // Never the full token endpoint URL.
    expect(JSON.stringify(meta)).not.toContain("/token");
  });

  it("recordMcpServerAuthorizationFailed writes mcp_server.authorization_failed with result=error + reason", async () => {
    const mcp_server_id = uuid();
    await recordMcpServerAuthorizationFailed({
      tenant_id,
      actor_id,
      mcp_server_id,
      namespace: "rovo",
      issuer: "https://auth.atlassian.example.com/authorize",
      reason: "issuer mismatch between callback and resource metadata",
      request_source: "cli",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_server.authorization_failed", mcp_server_id);
    expect(row.resource_type).toBe("mcp_server");
    expect(row.result).toBe("error");
    expect(row.reason).toBe("issuer mismatch between callback and resource metadata");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.issuer_host).toBe("auth.atlassian.example.com");
  });
});
