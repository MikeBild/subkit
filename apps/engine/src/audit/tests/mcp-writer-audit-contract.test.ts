import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { bucketSize } from "../buckets.ts";
import {
  AuditAction,
  recordConnectorMcpAuthorizationFailed,
  recordConnectorMcpAuthorizationStarted,
  recordConnectorMcpAuthorized,
  recordConnectorMcpClientRegistered,
  recordConnectorMcpHandshakeOk,
  recordConnectorMcpManifestDrift,
  recordMcpExternalToolInvoked,
  recordMcpExternalToolPaletteAssemblyFailed,
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

describe("reserved audit-action constants", () => {
  it("reserves the three connector.mcp_* session constants", () => {
    expect(AuditAction.CONNECTOR_MCP_HANDSHAKE_OK).toBe("connector.mcp_handshake_ok");
    expect(AuditAction.CONNECTOR_MCP_MANIFEST_DRIFT).toBe("connector.mcp_manifest_drift");
    expect(AuditAction.CONNECTOR_MCP_CLIENT_REGISTERED).toBe("connector.mcp_client_registered");
  });

  it("reserves the mcp_external_tool.invoked constant", () => {
    expect(AuditAction.MCP_EXTERNAL_TOOL_INVOKED).toBe("mcp_external_tool.invoked");
  });

  it("reserves the mcp_external_tool.palette_assembly_failed constant", () => {
    expect(AuditAction.MCP_EXTERNAL_TOOL_PALETTE_ASSEMBLY_FAILED).toBe(
      "mcp_external_tool.palette_assembly_failed",
    );
  });

  it("reserves the three connector.mcp_authoriz* constants", () => {
    expect(AuditAction.CONNECTOR_MCP_AUTHORIZATION_STARTED).toBe(
      "connector.mcp_authorization_started",
    );
    expect(AuditAction.CONNECTOR_MCP_AUTHORIZED).toBe("connector.mcp_authorized");
    expect(AuditAction.CONNECTOR_MCP_AUTHORIZATION_FAILED).toBe(
      "connector.mcp_authorization_failed",
    );
  });

  it("reserves the two external_provider.* constants", () => {
    expect(AuditAction.EXTERNAL_PROVIDER_CALL_SUCCEEDED).toBe("external_provider.call_succeeded");
    expect(AuditAction.EXTERNAL_PROVIDER_CALL_FAILED).toBe("external_provider.call_failed");
  });

  it("no longer reserves any mcp_server.* lifecycle constant", () => {
    const actions = Object.values(AuditAction) as string[];
    expect(actions.filter((a) => a.startsWith("mcp_server."))).toEqual([]);
  });
});

describe("external MCP session audit writers", () => {
  it("recordConnectorMcpHandshakeOk writes connector.mcp_handshake_ok against the connector", async () => {
    const connector_id = uuid();
    await recordConnectorMcpHandshakeOk({
      tenant_id,
      actor_id,
      connector_id,
      connector_slug: "notion",
      tool_count: 12,
      manifest_hash: "sha256:abcd1234",
      request_source: "scheduler",
      executor: ctx.db,
    });
    const row = await rowFor("connector.mcp_handshake_ok", connector_id);
    expect(row.resource_type).toBe("connector");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.connector_slug).toBe("notion");
    expect(meta.tool_count).toBe(12);
    expect(meta.manifest_hash).toBe("sha256:abcd1234");
  });

  it("recordConnectorMcpManifestDrift is its own action, not an update row carrying a changed_fields convention", async () => {
    const connector_id = uuid();
    await recordConnectorMcpManifestDrift({
      tenant_id,
      actor_id: null,
      connector_id,
      connector_slug: "notion",
      previous_hash: "v1:aaaa",
      observed_hash: "v1:bbbb",
      observed_tool_count: 9,
      request_source: "chat",
      executor: ctx.db,
    });
    const row = await rowFor("connector.mcp_manifest_drift", connector_id);
    expect(row.resource_type).toBe("connector");
    expect(row.reason).toBe("tool_manifest_drift");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.previous_hash).toBe("v1:aaaa");
    expect(meta.observed_hash).toBe("v1:bbbb");
    expect(meta.observed_tool_count).toBe(9);
  });

  it("recordConnectorMcpClientRegistered records the client id and never a secret", async () => {
    const connector_id = uuid();
    await recordConnectorMcpClientRegistered({
      tenant_id,
      actor_id: null,
      connector_id,
      connector_slug: "rovo",
      client_id: "dcr-issued-client",
      request_source: "api",
      executor: ctx.db,
    });
    const row = await rowFor("connector.mcp_client_registered", connector_id);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.client_id).toBe("dcr-issued-client");
    expect(JSON.stringify(meta)).not.toContain("client_secret");
  });

  it("recordMcpExternalToolInvoked writes mcp_external_tool.invoked with a byte bucket, not raw bytes", async () => {
    const connector_id = uuid();
    await recordMcpExternalToolInvoked({
      tenant_id,
      actor_id,
      connector_id,
      connector_slug: "notion",
      remote_tool: "search_pages",
      operation: "tools/call",
      outcome: "success",
      duration_ms: 842,
      byte_count: 2_000_000,
      request_source: "chat",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_external_tool.invoked", connector_id);
    expect(row.resource_type).toBe("mcp_external_tool");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.remote_tool).toBe("search_pages");
    expect(meta.operation).toBe("tools/call");
    expect(meta.outcome).toBe("success");
    expect(meta.duration_ms).toBe(842);
    expect(meta.byte_count_bucket).toBe(bucketSize(2_000_000));
    expect(meta.byte_count).toBeUndefined();
  });

  it("recordMcpExternalToolInvoked maps an error outcome to result=error", async () => {
    const connector_id = uuid();
    await recordMcpExternalToolInvoked({
      tenant_id,
      actor_id,
      connector_id,
      connector_slug: "github",
      remote_tool: "create_issue",
      operation: "tools/call",
      outcome: "error",
      duration_ms: 51,
      byte_count: 200,
      request_source: "chat",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_external_tool.invoked", connector_id);
    expect(row.result).toBe("error");
    expect((row.metadata as Record<string, unknown>).byte_count_bucket).toBe(bucketSize(200));
  });

  it("recordMcpExternalToolPaletteAssemblyFailed writes palette_assembly_failed with typed reason + detail in metadata", async () => {
    await recordMcpExternalToolPaletteAssemblyFailed({
      tenant_id,
      actor_id,
      reason: "pool_fault",
      detail: "connectable-connector enumeration failed",
      request_source: "chat",
      executor: ctx.db,
    });
    const row = await rowFor("mcp_external_tool.palette_assembly_failed", tenant_id);
    expect(row.resource_type).toBe("mcp_external_tool");
    expect(row.result).toBe("error");
    expect(row.reason).toBe("pool_fault");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.request_source).toBe("chat");
    expect(meta.detail).toBe("connectable-connector enumeration failed");
  });

  it("recordConnectorMcpAuthorizationStarted writes host-only issuer", async () => {
    const connector_id = uuid();
    await recordConnectorMcpAuthorizationStarted({
      tenant_id,
      actor_id,
      connector_id,
      connector_slug: "rovo",
      issuer: "https://auth.atlassian.example.com/authorize?client_id=abc&state=SECRET456",
      request_source: "cli",
      executor: ctx.db,
    });
    const row = await rowFor("connector.mcp_authorization_started", connector_id);
    expect(row.resource_type).toBe("connector");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.connector_slug).toBe("rovo");
    expect(meta.request_source).toBe("cli");
    expect(meta.issuer_host).toBe("auth.atlassian.example.com");
    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain("SECRET456");
    expect(metaStr).not.toContain("client_id=");
    expect(metaStr).not.toContain("/authorize");
  });

  it("recordConnectorMcpAuthorized writes host-only issuer", async () => {
    const connector_id = uuid();
    await recordConnectorMcpAuthorized({
      tenant_id,
      actor_id,
      connector_id,
      connector_slug: "rovo",
      issuer: "https://auth.atlassian.example.com/token",
      request_source: "api",
      executor: ctx.db,
    });
    const row = await rowFor("connector.mcp_authorized", connector_id);
    expect(row.resource_type).toBe("connector");
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.connector_slug).toBe("rovo");
    expect(meta.issuer_host).toBe("auth.atlassian.example.com");
    expect(JSON.stringify(meta)).not.toContain("/token");
  });

  it("recordConnectorMcpAuthorizationFailed writes result=error + reason", async () => {
    const connector_id = uuid();
    await recordConnectorMcpAuthorizationFailed({
      tenant_id,
      actor_id,
      connector_id,
      connector_slug: "rovo",
      issuer: "https://auth.atlassian.example.com/authorize",
      reason: "issuer mismatch between callback and resource metadata",
      request_source: "cli",
      executor: ctx.db,
    });
    const row = await rowFor("connector.mcp_authorization_failed", connector_id);
    expect(row.resource_type).toBe("connector");
    expect(row.result).toBe("error");
    expect(row.reason).toBe("issuer mismatch between callback and resource metadata");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.issuer_host).toBe("auth.atlassian.example.com");
  });
});
