import { beforeAll, describe, expect, test } from "bun:test";
import { withContext } from "../../logging/context.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { auditAwait } from "../audit.ts";
import { getAuditRowById, queryAuditLog, serializeAuditEntry } from "../query.ts";
import { recordExecutionCrashRecovered } from "../recorders/execution.ts";
import { recordKnowledgeSourceCandidatesSynthesized } from "../recorders/knowledge.ts";
import { AuditAction } from "../types.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb, uuid } from "./contracts-fixtures.ts";

useAuditContractsDb();

describe("request-source attribution", () => {
  const SOURCES = ["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"] as const;

  for (const source of SOURCES) {
    test(`metadata.request_source=${source} round-trips to persisted row`, async () => {
      const probeId = uuid();
      const entry = await auditAwait(
        {
          tenant_id: tenantA,
          action: "tenant.created",
          resource_type: "tenant",
          resource_id: probeId,
          result: "success",
          metadata: { request_source: source, marker: `rs-${source}` },
        },
        testDb.db,
      );
      const fetched = await getAuditRowById(testDb.db, tenantA, entry.id);
      expect(fetched).not.toBeNull();
      expect((fetched!.metadata as { request_source?: string }).request_source).toBe(source);
    });
  }

  test("trusted request context persists source and credential identity for filtering", async () => {
    const apiKeyId = uuid();
    const sessionId = uuid();
    const resourceId = uuid();
    const entry = await withContext(
      { request_source: "ui", api_key_id: apiKeyId, session_id: sessionId },
      () =>
        auditAwait(
          {
            tenant_id: tenantA,
            action: "knowledge_source.updated",
            resource_type: "knowledge_source",
            resource_id: resourceId,
            result: "success",
          },
          testDb.db,
        ),
    );
    const filtered = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      request_source: "ui",
      api_key_id: apiKeyId,
      session_id: sessionId,
      resource_id: resourceId,
    });
    expect(entry.metadata.audit_used_api_key_id).toBe(apiKeyId);
    expect(entry.metadata.audit_used_session_id).toBe(sessionId);
    expect(filtered.items.map((item) => item.id)).toContain(entry.id);
    const found = filtered.items.find((item) => item.id === entry.id);
    if (!found) throw new Error("filtered audit entry missing");
    const projected = serializeAuditEntry(found);
    expect(projected.request_source).toBe("ui");
    expect(projected.api_key_id).toBe(apiKeyId);
    expect(projected.session_id).toBe(sessionId);
    const otherTenant = await queryAuditLog(testDb.db, {
      tenant_id: tenantB,
      api_key_id: apiKeyId,
    });
    expect(otherTenant.items).toEqual([]);
  });

  test("event metadata cannot forge the credential used for a request", async () => {
    const forgedKeyId = uuid();
    const realSessionId = uuid();
    const entry = await withContext(
      { session_id: realSessionId, audit_access_type: "browser_session" },
      () =>
        auditAwait(
          {
            tenant_id: tenantA,
            action: "knowledge_source.updated",
            resource_type: "knowledge_source",
            resource_id: uuid(),
            metadata: {
              api_key_id: forgedKeyId,
              audit_used_api_key_id: forgedKeyId,
              audit_access_type: "api_key",
              audit_credential_origin: "cli_oauth_session",
            },
          },
          testDb.db,
        ),
    );
    const found = await getAuditRowById(testDb.db, tenantA, entry.id);
    if (!found) throw new Error("audit entry missing");
    const projected = serializeAuditEntry(found);
    expect(projected.api_key_id).toBeNull();
    expect(projected.session_id).toBe(realSessionId);
    expect(projected.access_type).toBe("browser_session");
    expect(projected.credential_origin).toBeNull();
    const forgedFilter = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      api_key_id: forgedKeyId,
    });
    expect(forgedFilter.items.map((item) => item.id)).not.toContain(entry.id);
  });

  test("historical recorded credential IDs remain searchable without becoming verified", async () => {
    const recordedKeyId = uuid();
    const entry = await auditAwait(
      {
        tenant_id: tenantA,
        action: "knowledge_source.updated",
        resource_type: "knowledge_source",
        resource_id: uuid(),
        metadata: { api_key_id: recordedKeyId },
      },
      testDb.db,
    );
    const found = await queryAuditLog(testDb.db, { tenant_id: tenantA, api_key_id: recordedKeyId });
    expect(found.items.map((item) => item.id)).toContain(entry.id);
    const historical = found.items.find((item) => item.id === entry.id);
    if (!historical) throw new Error("historical audit entry missing");
    const projected = serializeAuditEntry(historical);
    expect(projected.api_key_id).toBeNull();
    expect(projected.recorded_api_key_id).toBe(recordedKeyId);
  });

  test("API-key use receipts remain searchable by their resource ID", async () => {
    const apiKeyId = uuid();
    const receipt = await auditAwait(
      {
        tenant_id: tenantA,
        action: AuditAction.API_KEY_USED,
        resource_type: "api_key",
        resource_id: apiKeyId,
        metadata: { sampled: true },
      },
      testDb.db,
    );
    const found = await queryAuditLog(testDb.db, { tenant_id: tenantA, api_key_id: apiKeyId });
    expect(found.items.map((item) => item.id)).toContain(receipt.id);
    const foreign = await queryAuditLog(testDb.db, { tenant_id: tenantB, api_key_id: apiKeyId });
    expect(foreign.items.map((item) => item.id)).not.toContain(receipt.id);
  });
});

describe("query filter coverage", () => {
  let actorId: string;
  let traceId: string;
  let resourceId: string;

  beforeAll(async () => {
    actorId = uuid();
    traceId = uuid();
    resourceId = uuid();
    await auditAwait(
      {
        tenant_id: tenantA,
        actor_type: "user",
        actor_id: actorId,
        action: "credential.created",
        resource_type: "credential",
        resource_id: resourceId,
        result: "success",
        trace_id: traceId,
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantA,
        actor_type: "system",
        action: "credential.deleted",
        resource_type: "credential",
        resource_id: resourceId,
        result: "denied",
        reason: "not authorised",
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantA,
        actor_type: "user",
        actor_id: actorId,
        action: "workflow.created",
        resource_type: "workflow",
        result: "error",
      },
      testDb.db,
    );
  });

  test("actor_id filter narrows to that actor only", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, actor_id: actorId });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((e) => e.actor_id === actorId)).toBe(true);
  });

  test("actor_type filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, actor_type: "system" });
    expect(r.items.every((e) => e.actor_type === "system")).toBe(true);
  });

  test("resource_type filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, resource_type: "workflow" });
    expect(r.items.every((e) => e.resource_type === "workflow")).toBe(true);
  });

  test("resource_id filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, resource_id: resourceId });
    expect(r.items.every((e) => e.resource_id === resourceId)).toBe(true);
  });

  test("result filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, result: "denied" });
    expect(r.items.every((e) => e.result === "denied")).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
  });

  test("trace_id filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, trace_id: traceId });
    expect(r.items.every((e) => e.trace_id === traceId)).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
  });

  test("actions[] filter is an OR over the array", async () => {
    const r = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      actions: ["credential.created", "credential.deleted"],
    });
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    expect(
      r.items.every((e) => e.action === "credential.created" || e.action === "credential.deleted"),
    ).toBe(true);
  });

  test("ts_from / ts_to bound the result set", async () => {
    const probeTs = new Date(FROZEN_NOW);
    const probeId = uuid();
    await auditAwait(
      {
        tenant_id: tenantA,
        ts: probeTs,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: probeId,
        result: "success",
        metadata: { marker: "ts-bound-probe" },
      },
      testDb.db,
    );
    const past = new Date(FROZEN_NOW - 60 * 60 * 1000);
    const future = new Date(FROZEN_NOW + 60 * 60 * 1000);
    const insideWindow = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      ts_from: past,
      ts_to: future,
    });
    expect(
      insideWindow.items.some(
        (e) => (e.metadata as { marker?: string }).marker === "ts-bound-probe",
      ),
    ).toBe(true);
    const outsideWindow = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      ts_from: past,
      ts_to: new Date(FROZEN_NOW - 30 * 60 * 1000),
    });
    expect(
      outsideWindow.items.some(
        (e) => (e.metadata as { marker?: string }).marker === "ts-bound-probe",
      ),
    ).toBe(false);
  });

  test("ts_to excludes an event exactly at the upper boundary", async () => {
    const boundary = new Date(FROZEN_NOW);
    const resourceId = uuid();
    const entry = await auditAwait(
      {
        tenant_id: tenantA,
        ts: boundary,
        action: "knowledge_source.updated",
        resource_type: "knowledge_source",
        resource_id: resourceId,
      },
      testDb.db,
    );
    const excluded = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      resource_id: resourceId,
      ts_to: boundary,
    });
    expect(excluded.items.some((item) => item.id === entry.id)).toBe(false);
    const included = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      resource_id: resourceId,
      ts_from: boundary,
    });
    expect(included.items.some((item) => item.id === entry.id)).toBe(true);
  });

  test("limit + cursor walks pages newest-first", async () => {
    const first = await queryAuditLog(testDb.db, { tenant_id: tenantA }, { limit: 1 });
    expect(first.items.length).toBe(1);
    expect(first.next_cursor).not.toBeNull();
    const cursor = first.next_cursor!;
    const second = await queryAuditLog(testDb.db, { tenant_id: tenantA }, { limit: 1, cursor });
    expect(second.items.length).toBe(1);
    if (first.items[0] && second.items[0]) {
      expect(first.items[0].ts.getTime()).toBeGreaterThanOrEqual(second.items[0].ts.getTime());
    }
  });

  test("an exactly full final page has no continuation cursor", async () => {
    const resourceId = uuid();
    for (const offset of [0, 1]) {
      await auditAwait(
        {
          tenant_id: tenantA,
          action: AuditAction.SYSTEM_STARTUP,
          resource_type: "system",
          resource_id: resourceId,
          ts: new Date(Date.UTC(2026, 0, 1, 0, 0, offset)),
        },
        testDb.db,
      );
    }
    const page = await queryAuditLog(
      testDb.db,
      { tenant_id: tenantA, resource_id: resourceId },
      { limit: 2 },
    );
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  test("limit caps at MAX_LIMIT (500) silently", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA }, { limit: 9999 });
    expect(Array.isArray(r.items)).toBe(true);
  });

  test("serializeAuditEntry produces a JSON-safe shape", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA }, { limit: 1 });
    const entry = r.items[0];
    if (!entry) throw new Error("expected at least one row");
    const wire = serializeAuditEntry(entry);
    expect(typeof wire.ts).toBe("string");
    const json = JSON.stringify(wire);
    expect(json).toContain(entry.id);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.tenant_id).toBe(tenantA);
  });
});

describe("recorder catalog gap fillers", () => {
  test("recordExecutionCrashRecovered persists with system actor + workflow_id metadata", async () => {
    const executionId = uuid();
    const workflowId = uuid();
    const entry = await recordExecutionCrashRecovered({
      tenant_id: tenantA,
      actor_id: null,
      executor: testDb.db,
      execution_id: executionId,
      workflow_id: workflowId,
      reason: "engine_boot_reaper",
      metadata: { started_at: "2026-05-03T00:00:00Z", timeout_ms: 30000 },
    });
    expect(entry.action).toBe(AuditAction.EXECUTION_CRASH_RECOVERED);
    expect(entry.actor_type).toBe("system");
    expect((entry.metadata as { workflow_id?: string }).workflow_id).toBe(workflowId);
    const fetched = await getAuditRowById(testDb.db, tenantA, entry.id);
    expect(fetched?.resource_id).toBe(executionId);
  });

  test("recordExecutionCrashRecovered tolerates a null workflow_id", async () => {
    const executionId = uuid();
    const entry = await recordExecutionCrashRecovered({
      tenant_id: tenantA,
      actor_id: null,
      executor: testDb.db,
      execution_id: executionId,
      workflow_id: null,
      reason: "engine_boot_reaper",
      metadata: { started_at: "2026-05-03T00:00:00Z" },
    });
    expect((entry.metadata as { workflow_id?: string }).workflow_id).toBeUndefined();
  });

  test("recordKnowledgeSourceCandidatesSynthesized records the LLM-synth path", async () => {
    const ksId = uuid();
    const sourceKsId = uuid();
    const entry = await recordKnowledgeSourceCandidatesSynthesized({
      tenant_id: tenantA,
      actor_id: null,
      executor: testDb.db,
      knowledge_source_id: ksId,
      source_knowledge_source_id: sourceKsId,
      candidate_count: 4,
      endpoint_count: 17,
      model_used: "claude-sonnet-4-6",
      reason: "file_analysis",
      created: true,
    });
    expect(entry.action).toBe(AuditAction.KNOWLEDGE_SOURCE_CANDIDATES_SYNTHESIZED);
    const meta = entry.metadata as {
      candidate_count?: number;
      endpoint_count?: number;
      model_used?: string;
      created?: boolean;
    };
    expect(meta.candidate_count).toBe(4);
    expect(meta.endpoint_count).toBe(17);
    expect(meta.model_used).toBe("claude-sonnet-4-6");
    expect(meta.created).toBe(true);
  });
});
