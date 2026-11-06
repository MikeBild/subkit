import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../types.ts";
import {
  recordConnectorCreated,
  recordConnectorDeleted,
  recordConnectorDraftCredentialRejected,
  recordConnectorInvoked,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
  recordCredentialAttached,
  recordCredentialDeleted,
  recordCredentialRotated,
  recordEngineUpdateCompleted,
  recordEngineUpdateFailed,
  recordEngineUpdateInitiated,
  recordEngineUpdateRolledBack,
  recordKnowledgeSourceCreated,
  recordKnowledgeSourceRefreshed,
  recordOAuthClientRegistered,
  recordOAuthClientRegistrationFailed,
  recordToolPolicyConfirmationRequired,
  recordWorkflowCommitted,
  recordWorkflowCreated,
  recordWorkflowDeleted,
  recordWorkflowUpdated,
} from "./index.ts";
import { fetchRow, tenantId, testDb, useRecorderDb } from "./recorders-fixtures.ts";

useRecorderDb();

describe("recorder actor normalization", () => {
  test("persists an untyped actor ID as unknown without an actor ID", async () => {
    const entry = await recordWorkflowCreated({
      tenant_id: tenantId,
      actor_id: "untyped-actor",
      executor: testDb.db,
      workflow_id: "11111111-1111-1111-1111-111111111111",
      slug: "unknown-actor",
      version: null,
      reason: "test",
      source: "service",
    });
    const row = await fetchRow(entry.id);
    expect(row?.actor_type).toBe("unknown");
    expect(row?.actor_id).toBeNull();
  });
});

describe("recorder catalog — connector", () => {
  test("recordConnectorCreated", async () => {
    const entry = await recordConnectorCreated({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "11111111-1111-1111-1111-111111111111",
      slug: "do-conn",
      driver: "http",
      environment: "dev",
      reason: "auto_persist_on_confirmation",
      source: "harness_auto_persist",
      credential_persisted: true,
      commit_intent_kind: "save_connector_draft",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONNECTOR_CREATED);
    expect(row?.reason).toBe("auto_persist_on_confirmation");
    expect(row?.resource_type).toBe("connector");
    expect(row?.resource_id).toBe("11111111-1111-1111-1111-111111111111");
    expect((row!.metadata as Record<string, unknown>).source).toBe("harness_auto_persist");
    expect((row!.metadata as Record<string, unknown>).commit_intent_kind).toBe(
      "save_connector_draft",
    );
  });

  test("recordConnectorUpdated", async () => {
    const entry = await recordConnectorUpdated({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "22222222-2222-2222-2222-222222222222",
      kind: "credential_rotated",
      reason: "manual_re_issue",
      source: "tool_call",
      tool: "save_connector_draft",
      credential_mode: "bearer",
      environment: "prod",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONNECTOR_UPDATED);
    expect(row?.reason).toBe("manual_re_issue");
    expect((row!.metadata as Record<string, unknown>).kind).toBe("credential_rotated");
    expect((row!.metadata as Record<string, unknown>).tool).toBe("save_connector_draft");
  });

  test("recordConnectorDeleted", async () => {
    const entry = await recordConnectorDeleted({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "33333333-3333-3333-3333-333333333333",
      reason: "operator_requested_delete",
      source: "tool_call",
      slug: "to-be-removed",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONNECTOR_DELETED);
    expect(row?.reason).toBe("operator_requested_delete");
    expect((row!.metadata as Record<string, unknown>).slug).toBe("to-be-removed");
  });

  test("recordConnectorInvoked", async () => {
    const entry = await recordConnectorInvoked({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "44444444-4444-4444-4444-444444444444",
      connector_slug: "do",
      driver: "http",
      environment: "dev",
      method: "GET",
      path: "/v2/droplets",
      url_host: "api.digitalocean.com",
      status_code: 200,
      latency_ms: 120,
      outcome: "success",
      conversation_id: "conv-1",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONNECTOR_INVOKED);
    expect(row?.result).toBe("success");
    expect(row?.reason).toBe("tool_invocation");
    expect((row!.metadata as Record<string, unknown>).method).toBe("GET");
    expect((row!.metadata as Record<string, unknown>).status_code).toBe(200);
  });

  test("recordConnectorSavedOverride", async () => {
    const entry = await recordConnectorSavedOverride({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "55555555-5555-5555-5555-555555555555",
      slug: "broken-conn",
      driver: "http",
      environment: "dev",
      reason: "force_save_override",
      latest_probe: { ok: false, failure_code: "auth_failed" },
      source: "tool_call",
      tool: "save_connector_draft",
      probe_failure_code: "auth_failed",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONNECTOR_SAVED_OVERRIDE);
    expect(row?.reason).toBe("force_save_override");
    expect((row!.metadata as Record<string, unknown>).kind).toBe("force_save_override");
  });

  test("recordConnectorDraftCredentialRejected", async () => {
    const entry = recordConnectorDraftCredentialRejected({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      conversation_id: "conv-credreject",
      matched_key_path: "config.headers.Authorization",
    });
    await _drainAuditWritesForTests(testDb.db);
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED);
    expect(row?.result).toBe("denied");
    expect(row?.reason).toBe("credential_must_use_form");
    expect((row!.metadata as Record<string, unknown>).matched_key_path).toBe(
      "config.headers.Authorization",
    );
    const meta = JSON.stringify(row?.metadata);
    expect(meta).not.toMatch(/dop_v1_|Bearer /);
  });

  test("recordConnectorCreated scrubs secrets in metadata via the audit writer", async () => {
    const pat = "dop_v1_secrettokenabcdefabcdefabcdefabcdefab";
    const entry = await recordConnectorCreated({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "66666666-6666-6666-6666-666666666666",
      slug: `slug-${pat}`,
      driver: "http",
      environment: "dev",
      reason: "auto_persist_on_confirmation",
      source: "harness_auto_persist",
    });
    const row = await fetchRow(entry.id);
    const meta = JSON.stringify(row?.metadata);
    expect(meta).not.toContain(pat);
    expect(meta).toContain("REDACTED");
  });
});

describe("recorder catalog — workflow", () => {
  test("recordWorkflowCreated", async () => {
    const entry = await recordWorkflowCreated({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      workflow_id: "77777777-7777-7777-7777-777777777777",
      slug: "wf-a",
      version: 1,
      reason: "auto_persist_on_confirmation",
      source: "harness_auto_persist",
      commit_intent_kind: "save_workflow_draft",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.WORKFLOW_CREATED);
    expect(row?.reason).toBe("auto_persist_on_confirmation");
    expect(row?.actor_type).toBe("system");
    expect(row?.actor_id).toBeNull();
    expect((row!.metadata as Record<string, unknown>).version).toBe(1);
  });

  test("recordWorkflowCreated preserves a typed user actor", async () => {
    const actorId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const entry = await recordWorkflowCreated({
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: actorId,
      executor: testDb.db,
      workflow_id: "99999999-9999-9999-9999-999999999999",
      slug: "wf-typed-user",
      version: 1,
      reason: "test",
      source: "service",
    });
    const row = await fetchRow(entry.id);
    expect(row?.actor_type).toBe("user");
    expect(row?.actor_id).toBe(actorId);
  });

  test("recordWorkflowUpdated", async () => {
    const entry = await recordWorkflowUpdated({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      workflow_id: "88888888-8888-8888-8888-888888888888",
      slug: "wf-b",
      version: 2,
      workflow_version_id: "ver-1",
      reason: "manual_re_issue",
      source: "tool_call",
      kind: "save_via_tool",
      tool: "save_workflow_draft",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.WORKFLOW_UPDATED);
    expect(row?.reason).toBe("manual_re_issue");
    expect((row!.metadata as Record<string, unknown>).kind).toBe("save_via_tool");
  });

  test("recordWorkflowDeleted", async () => {
    const entry = await recordWorkflowDeleted({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      workflow_id: "99999999-9999-9999-9999-999999999999",
      reason: "operator_requested_delete",
      source: "tool_call",
      slug: "wf-removed",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.WORKFLOW_DELETED);
    expect(row?.reason).toBe("operator_requested_delete");
  });

  test("recordWorkflowCommitted (force_commit override)", async () => {
    const entry = await recordWorkflowCommitted({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      workflow_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      workflow_version_id: "ver-2",
      version: 3,
      reason: "force_save_override",
      source: "tool_call",
      tool: "save_workflow_draft",
      latest_preview_summary: { ok: false },
      latest_preview_warnings: [{ code: "preview_failed" }],
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.WORKFLOW_COMMITTED_OVERRIDE);
    expect(row?.reason).toBe("force_save_override");
    expect((row!.metadata as Record<string, unknown>).kind).toBe("force_save_override");
  });
});

describe("recorder catalog — credential", () => {
  test("recordCredentialAttached", async () => {
    const entry = await recordCredentialAttached({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      credential_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      connector_id: "11111111-1111-1111-1111-111111111111",
      environment: "dev",
      mode: "bearer",
      reason: "auto_persist_on_confirmation",
      source: "harness_auto_persist",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CREDENTIAL_CREATED);
    expect(row?.reason).toBe("auto_persist_on_confirmation");
    expect((row!.metadata as Record<string, unknown>).mode).toBe("bearer");
  });

  test("recordCredentialRotated", async () => {
    const entry = await recordCredentialRotated({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      credential_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      connector_id: "11111111-1111-1111-1111-111111111111",
      environment: "prod",
      mode: "basic",
      reason: "manual_re_issue",
      source: "tool_call",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CREDENTIAL_ROTATED);
    expect(row?.reason).toBe("manual_re_issue");
  });

  test("recordCredentialDeleted", async () => {
    const entry = await recordCredentialDeleted({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      credential_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      connector_id: "11111111-1111-1111-1111-111111111111",
      environment: "dev",
      reason: "operator_revoked",
      source: "service",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CREDENTIAL_DELETED);
    expect(row?.reason).toBe("operator_revoked");
  });
});

describe("recorder catalog — knowledge_source", () => {
  test("recordKnowledgeSourceCreated", async () => {
    const entry = await recordKnowledgeSourceCreated({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      knowledge_source_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      source_type: "discovery_endpoint_index",
      source_uri: "https://example.com/openapi.json",
      cache_key: "url:abc123",
      reason: "discovery_cache_refresh",
      endpoint_count: 42,
      strategy: "openapi_v3",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.KNOWLEDGE_SOURCE_CREATED);
    expect(row?.reason).toBe("discovery_cache_refresh");
    expect((row!.metadata as Record<string, unknown>).endpoint_count).toBe(42);
  });

  test("recordKnowledgeSourceRefreshed", async () => {
    const entry = await recordKnowledgeSourceRefreshed({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      knowledge_source_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      source_type: "discovery_endpoint_index",
      source_uri: "https://example.com/openapi.json",
      cache_key: "url:abc123",
      reason: "discovery_cache_refresh",
      endpoint_count: 50,
      strategy: "openapi_v3",
      created: false,
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.KNOWLEDGE_SOURCE_REFRESHED);
    expect(row?.reason).toBe("discovery_cache_refresh");
    expect((row!.metadata as Record<string, unknown>).created).toBe(false);
  });
});

describe("recorder catalog — policy", () => {
  test("recordToolPolicyConfirmationRequired", async () => {
    const entry = await recordToolPolicyConfirmationRequired({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      conversation_id: "conv-policy-1",
      tool: "delete_connector",
      mode: "confirm_before_execution",
      confirmation_kind: "delete_connector",
      resolver_reason: "dangerous_tool",
      environment: "prod",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED);
    expect(row?.result).toBe("denied");
    expect(row?.reason).toBe("confirm_before_execution");
    expect((row!.metadata as Record<string, unknown>).tool).toBe("delete_connector");
    expect((row!.metadata as Record<string, unknown>).resolver_reason).toBe("dangerous_tool");
  });
});

describe("recorder catalog — engine_update", () => {
  const FIXED_HEX = "a".repeat(64);

  test("recordEngineUpdateInitiated lands under SYSTEM_TENANT_ID with the system actor", async () => {
    const entry = await recordEngineUpdateInitiated({
      executor: testDb.db,
      from_version: "4.2.0",
      to_version: "4.3.0",
      channel: "stable",
      request_source: "self-update",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.ENGINE_UPDATE_INITIATED);
    expect(row?.tenant_id).toBe(SYSTEM_TENANT_ID);
    expect(row?.actor_type).toBe("system");
    expect(row?.actor_id).toBeNull();
    expect(row?.result).toBe("success");
    expect(row?.reason).toBe("self-update binary swap");
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.from_version).toBe("4.2.0");
    expect(meta.to_version).toBe("4.3.0");
    expect(meta.channel).toBe("stable");
    expect(meta.request_source).toBe("self-update");
    expect(meta.sha256).toBe("");
    expect(meta.actor).toBeUndefined();
  });

  test("recordEngineUpdateCompleted carries the verified sha256", async () => {
    const entry = await recordEngineUpdateCompleted({
      executor: testDb.db,
      from_version: "4.2.0",
      to_version: "4.3.0",
      channel: "stable",
      sha256: FIXED_HEX,
      request_source: "self-update",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.ENGINE_UPDATE_COMPLETED);
    expect(row?.result).toBe("success");
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.sha256).toBe(FIXED_HEX);
  });

  test("recordEngineUpdateFailed records result=error and a free-form reason", async () => {
    const entry = await recordEngineUpdateFailed({
      executor: testDb.db,
      from_version: "4.2.0",
      to_version: "4.3.0",
      channel: "stable",
      request_source: "self-update",
      reason: "checksum mismatch for engine_linux_x64",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.ENGINE_UPDATE_FAILED);
    expect(row?.result).toBe("error");
    expect(row?.reason).toBe("checksum mismatch for engine_linux_x64");
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.sha256).toBe("");
  });

  test("recordEngineUpdateRolledBack hard-codes request_source=rollback", async () => {
    const entry = await recordEngineUpdateRolledBack({
      executor: testDb.db,
      from_version: "4.3.0",
      to_version: "4.2.0",
      channel: "stable",
      sha256: FIXED_HEX,
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.ENGINE_UPDATE_ROLLED_BACK);
    expect(row?.result).toBe("success");
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.request_source).toBe("rollback");
  });

  test("EngineUpdateMetadataSchema rejects almost-hex sha256 values", async () => {
    await expect(
      recordEngineUpdateCompleted({
        executor: testDb.db,
        from_version: "4.2.0",
        to_version: "4.3.0",
        channel: "stable",
        sha256: "not-hex",
        request_source: "self-update",
      }),
    ).rejects.toThrow();
  });
});

describe("recorder catalog — oauth_client (RFC 7591)", () => {
  test("recordOAuthClientRegistered persists host-only metadata under the tenant", async () => {
    const entry = await recordOAuthClientRegistered({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "33333333-3333-3333-3333-333333333333",
      issuer_url_host: "auth.example.com",
      registration_endpoint_host: "auth.example.com",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.OAUTH_CLIENT_REGISTERED);
    expect(row?.result).toBe("success");
    expect(row?.tenant_id).toBe(tenantId);
    expect(row?.resource_type).toBe("connector");
    expect(row?.resource_id).toBe("33333333-3333-3333-3333-333333333333");
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.issuer_url_host).toBe("auth.example.com");
    expect(meta.registration_endpoint_host).toBe("auth.example.com");
    expect(String(meta.issuer_url_host)).not.toContain("/");
    expect(String(meta.issuer_url_host)).not.toContain("://");
  });

  test("recordOAuthClientRegistrationFailed carries error_code and tolerates a null endpoint", async () => {
    const entry = await recordOAuthClientRegistrationFailed({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: "44444444-4444-4444-4444-444444444444",
      issuer_url_host: "auth.example.com",
      registration_endpoint_host: null,
      error_code: "registration_http_401",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.OAUTH_CLIENT_REGISTRATION_FAILED);
    expect(row?.result).toBe("error");
    expect(row?.resource_type).toBe("connector");
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.error_code).toBe("registration_http_401");
    expect(meta.issuer_url_host).toBe("auth.example.com");
    expect(meta.registration_endpoint_host).toBeNull();
  });
});

describe("recorder catalog — coverage matrix", () => {
  test("every recorder write lands a row with non-null reason and the canonical action", async () => {
    const rows = await testDb.db.execute(
      sql`SELECT action, reason, metadata FROM audit_log
          WHERE tenant_id = ${tenantId}::uuid
             OR tenant_id = ${SYSTEM_TENANT_ID}::uuid`,
    );
    const list = (
      rows as unknown as {
        rows: Array<{ action: string; reason: string | null; metadata: unknown }>;
      }
    ).rows;

    const expectedActions = new Set<string>([
      AuditAction.CONNECTOR_CREATED,
      AuditAction.CONNECTOR_UPDATED,
      AuditAction.CONNECTOR_DELETED,
      AuditAction.CONNECTOR_INVOKED,
      AuditAction.CONNECTOR_SAVED_OVERRIDE,
      AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED,
      AuditAction.WORKFLOW_CREATED,
      AuditAction.WORKFLOW_UPDATED,
      AuditAction.WORKFLOW_DELETED,
      AuditAction.WORKFLOW_COMMITTED_OVERRIDE,
      AuditAction.CREDENTIAL_CREATED,
      AuditAction.CREDENTIAL_ROTATED,
      AuditAction.CREDENTIAL_DELETED,
      AuditAction.KNOWLEDGE_SOURCE_CREATED,
      AuditAction.KNOWLEDGE_SOURCE_REFRESHED,
      AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
      AuditAction.ENGINE_UPDATE_INITIATED,
      AuditAction.ENGINE_UPDATE_COMPLETED,
      AuditAction.ENGINE_UPDATE_FAILED,
      AuditAction.ENGINE_UPDATE_ROLLED_BACK,
    ]);
    const seen = new Set(list.map((r) => r.action));
    for (const expected of expectedActions) {
      expect(seen.has(expected)).toBe(true);
    }
    const blankReason = list.filter(
      (r) =>
        (r.reason === null || r.reason === "") &&
        r.action !== AuditAction.OAUTH_CLIENT_REGISTERED &&
        r.action !== AuditAction.OAUTH_CLIENT_REGISTRATION_FAILED,
    );
    expect(blankReason.length).toBe(0);
  });
});
