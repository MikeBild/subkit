import { describe, expect, test } from "bun:test";
import type { AuditEntry, AuditQueryFilters } from "../../../audit/index.ts";
import { getAuditEntryTool, queryAuditTool } from "../engine-api/audit.ts";
import type { ToolContext } from "../index.ts";

type RecordedFilters = Partial<Omit<AuditQueryFilters, "tenant_id">>;

function makeCtx(): { ctx: ToolContext; recorded: RecordedFilters[] } {
  const recorded: RecordedFilters[] = [];
  const ctx = {
    engineClient: {
      audit: {
        query: async (filters: RecordedFilters) => {
          recorded.push(filters);
          return { items: [], next_cursor: null };
        },
      },
    },
  } as unknown as ToolContext;
  return { ctx, recorded };
}

describe("list_audit action filter", () => {
  test("maps singular `action` arg to `actions` array; no singular key", async () => {
    const { ctx, recorded } = makeCtx();

    const res = await queryAuditTool.execute(ctx, { action: "connector.invoked" });

    expect(res.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    const filters = recorded[0] as Record<string, unknown>;
    expect(filters.actions).toEqual(["connector.invoked"]);
    expect("action" in filters).toBe(false);
  });

  test("passes resource_type and resource_id through unchanged", async () => {
    const { ctx, recorded } = makeCtx();

    await queryAuditTool.execute(ctx, {
      resource_type: "workflow",
      resource_id: "wf-123",
      action: "workflow.executed",
    });

    const filters = recorded[0] as Record<string, unknown>;
    expect(filters.resource_type).toBe("workflow");
    expect(filters.resource_id).toBe("wf-123");
    expect(filters.actions).toEqual(["workflow.executed"]);
  });

  test("omits the actions filter entirely when no action arg is given", async () => {
    const { ctx, recorded } = makeCtx();

    await queryAuditTool.execute(ctx, { resource_type: "workflow" });

    const filters = recorded[0] as Record<string, unknown>;
    expect("actions" in filters).toBe(false);
    expect("action" in filters).toBe(false);
    expect(filters.resource_type).toBe("workflow");
  });

  test("passes trusted provenance and correlation filters without rewriting them", async () => {
    const { ctx, recorded } = makeCtx();
    const correlationId = "a".repeat(32);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const apiKeyId = "22222222-2222-4222-8222-222222222222";
    const start = "2026-10-19T08:00:00.000Z";
    const end = "2026-10-19T09:00:00.000Z";
    await queryAuditTool.execute(ctx, {
      actor_type: "user",
      api_key_id: apiKeyId,
      session_id: sessionId,
      request_source: "cli",
      origin_source: "mcp",
      execution_source: "queue",
      correlation_id: correlationId,
      result: "denied",
      ts_from: start,
      ts_to: end,
    });
    expect(recorded[0]).toMatchObject({
      actor_type: "user",
      api_key_id: apiKeyId,
      session_id: sessionId,
      request_source: "cli",
      origin_source: "mcp",
      execution_source: "queue",
      correlation_id: correlationId,
      result: "denied",
      ts_from: new Date(start),
      ts_to: new Date(end),
    });
  });
});

test("MCP list and detail expose the same redacted audit evidence", async () => {
  const entry: AuditEntry = {
    id: "11111111-1111-4111-8111-111111111111",
    ts: new Date("2026-10-19T08:00:00.000Z"),
    tenant_id: "22222222-2222-4222-8222-222222222222",
    actor_type: "user",
    actor_id: "33333333-3333-4333-8333-333333333333",
    action: "knowledge_source.updated",
    resource_type: "knowledge_source",
    resource_id: "44444444-4444-4444-8444-444444444444",
    result: "success",
    trace_id: "trace",
    ip: "private-ip-canary",
    user_agent: "private-agent-canary",
    before: { name: "Vertragsarchiv", password: "private-before-canary" },
    after: { name: "Vertragsarchiv", status: "active" },
    reason: "private free text canary",
    metadata: {
      origin_source: "ui",
      execution_source: "queue",
      audit_trace_id: "a".repeat(32),
      payload: "private-metadata-canary",
    },
  };
  const ctx = {
    engineClient: {
      audit: {
        query: async () => ({ items: [entry], next_cursor: null }),
        get: async () => entry,
      },
    },
  } as unknown as ToolContext;
  const listed = await queryAuditTool.execute(ctx, {});
  const detail = await getAuditEntryTool.execute(ctx, { id: entry.id });
  expect(listed.ok).toBe(true);
  expect(detail.ok).toBe(true);
  const listEntry = (listed.data as { entries: unknown[] }).entries[0];
  const detailEntry = (detail.data as { entry: unknown }).entry;
  expect(listEntry).toEqual(detailEntry);
  const wire = JSON.stringify(detailEntry);
  expect(wire).toContain('"origin_source":"ui"');
  expect(wire).toContain('"execution_source":"queue"');
  for (const privateValue of [
    "private-ip-canary",
    "private-agent-canary",
    "private-before-canary",
    "private-metadata-canary",
  ]) {
    expect(wire).not.toContain(privateValue);
  }
});
