import { describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { _drainAuditWritesForTests } from "../audit.ts";
import {
  recordConnectorCreated,
  recordConnectorDeleted,
  recordConnectorDraftCredentialRejected,
  recordConnectorInvoked,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
} from "../recorders/connector.ts";
import { fetchRow, tenantId, testDb, useRecorderDb } from "../recorders/recorders-fixtures.ts";
import {
  recordWorkflowCommitted,
  recordWorkflowDeleted,
  recordWorkflowUpdated,
} from "../recorders/workflow.ts";

useRecorderDb();

const uuid = createDeterministicUuidFactory(0xca7a1);
const actor = () => ({ tenant_id: tenantId, actor_id: null, executor: testDb.db });

async function stored(id: string) {
  const row = await fetchRow(id);
  return {
    resource_type: row?.resource_type,
    resource_id: row?.resource_id,
    metadata: row?.metadata,
  };
}

describe("connector recorders keep every given flag, including false", () => {
  test("a created connector records a false credential_persisted and the intent", async () => {
    const id = uuid();
    const entry = await recordConnectorCreated({
      ...actor(),
      connector_id: id,
      slug: "crm",
      driver: "http",
      environment: "dev",
      reason: "r",
      source: "tool_call",
      credential_persisted: false,
      commit_intent_kind: "save_connector",
    });
    expect(await stored(entry.id)).toEqual({
      resource_type: "connector",
      resource_id: id,
      metadata: {
        source: "tool_call",
        slug: "crm",
        driver: "http",
        environment: "dev",
        credential_persisted: false,
        commit_intent_kind: "save_connector",
      },
    });
  });

  test("an updated connector records every optional field and redacts the credential-named mode", async () => {
    const id = uuid();
    const entry = await recordConnectorUpdated({
      ...actor(),
      connector_id: id,
      kind: "config",
      reason: "r",
      source: "tool_call",
      environment: "prod",
      credential_mode: "oauth2",
      credential_persisted: false,
      idempotent: false,
      tool: "save_connector_draft",
      commit_intent_kind: "save",
    });
    expect(await stored(entry.id)).toEqual({
      resource_type: "connector",
      resource_id: id,
      metadata: {
        source: "tool_call",
        kind: "config",
        environment: "prod",
        credential_mode: "***REDACTED:key_value***",
        credential_persisted: false,
        idempotent: false,
        tool: "save_connector_draft",
        commit_intent_kind: "save",
      },
    });
  });

  test("a deleted connector is recorded on the connector", async () => {
    const id = uuid();
    const entry = await recordConnectorDeleted({
      ...actor(),
      connector_id: id,
      reason: "r",
      source: "service",
    });
    expect(await stored(entry.id)).toEqual({
      resource_type: "connector",
      resource_id: id,
      metadata: { source: "service" },
    });
  });

  test("an invocation that created a resource records its id", async () => {
    const id = uuid();
    const created = uuid();
    const entry = await recordConnectorInvoked({
      ...actor(),
      connector_id: id,
      connector_slug: "crm",
      driver: "http",
      environment: "prod",
      method: "POST",
      path: "/contacts",
      url_host: "api.example.com",
      status_code: 201,
      latency_ms: 9,
      outcome: "success",
      created_resource_id: created,
    });
    const row = await stored(entry.id);
    expect(row.resource_type).toBe("connector");
    expect((row.metadata as Record<string, unknown>).created_resource_id).toBe(created);
  });

  test("a saved override records a null probe, a null failure code and false flags", async () => {
    const id = uuid();
    const entry = await recordConnectorSavedOverride({
      ...actor(),
      connector_id: id,
      slug: "crm",
      driver: "http",
      environment: "dev",
      reason: "r",
      latest_probe: undefined,
      source: "tool_call",
      tool: "save_connector_draft",
      probe_failure_code: null,
      forced: false,
      cooldown_bypassed: false,
    });
    expect(await stored(entry.id)).toEqual({
      resource_type: "connector",
      resource_id: id,
      metadata: {
        source: "tool_call",
        kind: "force_save_override",
        slug: "crm",
        driver: "http",
        environment: "dev",
        latest_probe: null,
        tool: "save_connector_draft",
        probe_failure_code: null,
        forced: false,
        cooldown_bypassed: false,
      },
    });
  });

  test("a rejected draft credential is recorded as a denial on the conversation", async () => {
    const conversationId = uuid();
    const entry = recordConnectorDraftCredentialRejected({
      ...actor(),
      conversation_id: conversationId,
      matched_key_path: "auth.token",
    });
    await _drainAuditWritesForTests(testDb.db);
    const row = await fetchRow(entry.id);
    expect(row?.resource_type).toBe("conversation");
    expect(row?.resource_id).toBe(conversationId);
    expect(row?.result).toBe("denied");
    expect(row?.reason).toBe("credential_must_use_form");
  });
});

describe("workflow recorders keep every given field", () => {
  test("an update records the version id and tool", async () => {
    const id = uuid();
    const versionId = uuid();
    const entry = await recordWorkflowUpdated({
      ...actor(),
      workflow_id: id,
      slug: "wf",
      version: 2,
      workflow_version_id: versionId,
      reason: "r",
      source: "tool_call",
      kind: "save",
      tool: "save_workflow_draft",
      commit_intent_kind: "save_workflow_draft",
    });
    expect(await stored(entry.id)).toEqual({
      resource_type: "workflow",
      resource_id: id,
      metadata: {
        source: "tool_call",
        slug: "wf",
        version: 2,
        workflow_version_id: versionId,
        kind: "save",
        tool: "save_workflow_draft",
        commit_intent_kind: "save_workflow_draft",
      },
    });
  });

  test("a delete records the slug when known and omits it otherwise", async () => {
    const id = uuid();
    const withSlug = await recordWorkflowDeleted({
      ...actor(),
      workflow_id: id,
      reason: "r",
      source: "service",
      slug: "wf",
    });
    expect(await stored(withSlug.id)).toEqual({
      resource_type: "workflow",
      resource_id: id,
      metadata: { source: "service", slug: "wf" },
    });
    const without = await recordWorkflowDeleted({
      ...actor(),
      workflow_id: id,
      reason: "r",
      source: "service",
    });
    expect((await stored(without.id)).metadata).toEqual({ source: "service" });
  });

  test("a committed override records the version, preview evidence and tool", async () => {
    const id = uuid();
    const versionId = uuid();
    const entry = await recordWorkflowCommitted({
      ...actor(),
      workflow_id: id,
      workflow_version_id: versionId,
      version: null,
      reason: "r",
      source: "tool_call",
      latest_preview_summary: { ok: false },
      latest_preview_warnings: [],
      tool: "commit_workflow",
    });
    expect(await stored(entry.id)).toEqual({
      resource_type: "workflow",
      resource_id: id,
      metadata: {
        source: "tool_call",
        kind: "force_save_override",
        workflow_version_id: versionId,
        version: null,
        latest_preview_summary: { ok: false },
        latest_preview_warnings: [],
        tool: "commit_workflow",
      },
    });
  });

  test("a committed override without optional fields records only source and kind", async () => {
    const entry = await recordWorkflowCommitted({
      ...actor(),
      workflow_id: uuid(),
      reason: "r",
      source: "harness_auto_persist",
      kind: "auto",
    });
    expect((await stored(entry.id)).metadata).toEqual({
      source: "harness_auto_persist",
      kind: "auto",
    });
  });
});
