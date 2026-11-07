import { describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { queryAuditLog } from "../query.ts";
import { recordConnectorDiscovered, recordConnectorProbed } from "../recorders/connector.ts";
import { fetchRow, tenantId, testDb, useRecorderDb } from "../recorders/recorders-fixtures.ts";
import {
  recordWorkflowCreated,
  recordWorkflowScheduleNotBound,
  recordWorkflowUpdated,
} from "../recorders/workflow.ts";
import { AuditAction } from "../types.ts";

useRecorderDb();

const uuid = createDeterministicUuidFactory(0xc0ec7);

function connector(base_url: string | null) {
  return { id: uuid(), slug: "crm", driver: "http", environment: "prod", base_url };
}

describe("recordConnectorProbed", () => {
  test("a disabled connector probe writes no row", async () => {
    const target = connector("https://api.example.com/v1");
    const entry = await recordConnectorProbed({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector: target,
      result: { ok: false, latency_ms: 0, error_code: "connector_disabled" },
    });
    expect(entry).toBeNull();
    const rows = await queryAuditLog(testDb.db, { tenant_id: tenantId, resource_id: target.id });
    expect(rows.items).toEqual([]);
  });

  test("a successful probe is recorded as a PROBE invocation with only the host of the base URL", async () => {
    const target = connector("https://user:pw@api.example.com:8443/v1?token=abc");
    const conversationId = uuid();
    const userId = uuid();
    const entry = await recordConnectorProbed({
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: userId,
      executor: testDb.db,
      connector: target,
      result: { ok: true, latency_ms: 42 },
      conversation_id: conversationId,
    });
    const row = await fetchRow(entry?.id ?? "");
    expect(row?.action).toBe(AuditAction.CONNECTOR_INVOKED);
    expect(row?.result).toBe("success");
    expect(row?.actor_type).toBe("user");
    expect(row?.actor_id).toBe(userId);
    expect(row?.metadata).toEqual({
      conversation_id: conversationId,
      connector_id: target.id,
      connector_slug: "crm",
      driver: "http",
      environment: "prod",
      method: "PROBE",
      path: "/",
      url_host: "api.example.com:8443",
      status_code: 200,
      latency_ms: 42,
    });
  });

  test("a failed probe without a status records status 0 and an error result", async () => {
    const entry = await recordConnectorProbed({
      tenant_id: tenantId,
      actor_id: null,
      connector: connector(null),
      executor: testDb.db,
      result: { ok: false, latency_ms: 5, error_code: "timeout" },
    });
    const row = await fetchRow(entry?.id ?? "");
    expect(row?.result).toBe("error");
    expect(row?.actor_type).toBe("system");
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.status_code).toBe(0);
    expect(metadata.url_host).toBe("");
    expect("conversation_id" in metadata).toBe(false);
  });

  test("an explicit status wins and an unparsable base URL is recorded as given", async () => {
    const entry = await recordConnectorProbed({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector: connector("not a url"),
      result: { ok: true, status: 204, latency_ms: 1 },
    });
    const metadata = (await fetchRow(entry?.id ?? ""))?.metadata as Record<string, unknown>;
    expect(metadata.status_code).toBe(204);
    expect(metadata.url_host).toBe("not a url");
  });
});

describe("recordConnectorDiscovered", () => {
  test("warnings are counted in full but at most 25 are stored", async () => {
    const connectorId = uuid();
    const warnings = Array.from({ length: 30 }, (_, i) => ({ code: `w${i}`, message: `m${i}` }));
    const entry = await recordConnectorDiscovered({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: connectorId,
      strategy: "openapi",
      cache_key: "k1",
      source: "fresh",
      endpoint_count: 12,
      warnings,
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONNECTOR_DISCOVERED);
    expect(row?.resource_id).toBe(connectorId);
    expect(row?.reason).toBeNull();
    const metadata = row?.metadata as { warning_count: number; warnings: { code: string }[] };
    expect(metadata.warning_count).toBe(30);
    expect(metadata.warnings.map((w) => w.code)).toEqual(warnings.slice(0, 25).map((w) => w.code));
  });

  test("a discovery without warnings stores no warnings list", async () => {
    const entry = await recordConnectorDiscovered({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      connector_id: uuid(),
      strategy: "graphql",
      cache_key: "k2",
      source: "cache",
      endpoint_count: 0,
      warnings: [],
    });
    expect((await fetchRow(entry.id))?.metadata).toEqual({
      strategy: "graphql",
      cache_key: "k2",
      source: "cache",
      endpoint_count: 0,
      warning_count: 0,
    });
  });
});

describe("workflow override flags", () => {
  const base = () => ({ tenant_id: tenantId, actor_id: null, slug: "wf", version: 3, reason: "r" });

  test("a create forced over runtime data records the flag, the preview class and a bypass", async () => {
    const entry = await recordWorkflowCreated({
      ...base(),
      executor: testDb.db,
      workflow_id: uuid(),
      source: "tool_call",
      forced_over_runtime_data: true,
      preview_failure_class: "missing_credentials",
      bypassed_prior_approval: true,
    });
    expect((await fetchRow(entry.id))?.metadata).toEqual({
      source: "tool_call",
      slug: "wf",
      version: 3,
      forced_over_runtime_data: true,
      preview_failure_class: "missing_credentials",
      bypassed_prior_approval: true,
    });
  });

  test("a preview class without the force flag is not recorded", async () => {
    const entry = await recordWorkflowCreated({
      ...base(),
      executor: testDb.db,
      workflow_id: uuid(),
      source: "service",
      forced_over_runtime_data: false,
      preview_failure_class: "missing_credentials",
    });
    expect((await fetchRow(entry.id))?.metadata).toEqual({
      source: "service",
      slug: "wf",
      version: 3,
    });
  });

  test("an update forced over runtime data without a preview class records only the flag", async () => {
    const entry = await recordWorkflowUpdated({
      ...base(),
      executor: testDb.db,
      workflow_id: uuid(),
      source: "tool_call",
      commit_intent_kind: "save",
      forced_over_runtime_data: true,
      bypassed_prior_approval: true,
    });
    expect((await fetchRow(entry.id))?.metadata).toEqual({
      source: "tool_call",
      slug: "wf",
      version: 3,
      commit_intent_kind: "save",
      forced_over_runtime_data: true,
      bypassed_prior_approval: true,
    });
  });

  test("an update forced over runtime data records the preview class", async () => {
    const entry = await recordWorkflowUpdated({
      ...base(),
      executor: testDb.db,
      workflow_id: uuid(),
      source: "tool_call",
      forced_over_runtime_data: true,
      preview_failure_class: "connector_unreachable",
    });
    const metadata = (await fetchRow(entry.id))?.metadata as Record<string, unknown>;
    expect(metadata.preview_failure_class).toBe("connector_unreachable");
    expect("bypassed_prior_approval" in metadata).toBe(false);
  });
});

describe("recordWorkflowScheduleNotBound", () => {
  test("records a warning with the matched phrases on the workflow", async () => {
    const workflowId = uuid();
    const entry = await recordWorkflowScheduleNotBound({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      workflow_id: workflowId,
      slug: "daily-report",
      matched_phrases: ["every morning", "daily"],
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.WORKFLOW_SCHEDULE_NOT_BOUND);
    expect(row?.resource_type).toBe("workflow");
    expect(row?.resource_id).toBe(workflowId);
    expect(row?.result).toBe("success");
    expect(row?.metadata).toEqual({
      kind: "warning",
      slug: "daily-report",
      matched_phrases: ["every morning", "daily"],
    });
  });
});
