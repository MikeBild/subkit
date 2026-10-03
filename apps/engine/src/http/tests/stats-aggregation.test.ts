// Integration tests for stats aggregation correctness.
//
// Seeds a controlled set of rows in executions, audit_log, and llm_usage
// within a fixed window. Verifies:
//   - Window totals match Σ of seeded rows.
//   - duration_ms.total = Σ(finished_at - started_at) in milliseconds.
//   - Per-bucket sums equal window totals (no double-counting).
//   - Σ group totals = window totals for a single group_by axis.
//   - Token sums for LLM usage.
//   - request_source="wait_reaper" is accepted (open set).
//   - Connector status-class mapping (200→2xx, 401/403→4xx_auth,
//     429→4xx_rate_limited, error+no-status→network_error).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  auditLog,
  executions,
  llmUsage,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x01);

let srv: HttpTestServer;

// Window: 2026-01-15, hour bucket, UTC
const FROM = "2026-01-15T00:00:00.000Z";
const TO = "2026-01-15T23:59:59.999Z";
const WIN = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

// Connector id used in audit rows.
const CONNECTOR_ID = uuid();
const CONNECTOR_ID_2 = uuid();

// Execution durations seeded (ms): 10000, 20000, 30000
// Total: 60000ms
const EXEC_DURATIONS_MS = [10_000, 20_000, 30_000];
const TOTAL_EXEC_DURATION_MS = EXEC_DURATIONS_MS.reduce((a, b) => a + b, 0);

let wfId = "";

beforeAll(async () => {
  srv = await createHttpTestServer("stats-agg");
  const db = srv.db;

  // Seed a workflow for the FK.
  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug: "wf-agg", name: "Agg", lifecycle: "active" })
    .returning();
  wfId = wf!.id;
  const [wfv] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: wfId,
      version: 1,
      dag: { steps: [] },
    })
    .returning();

  const baseStart = new Date("2026-01-15T08:00:00.000Z");
  const execValues = EXEC_DURATIONS_MS.map((durMs, i) => ({
    tenant_id: srv.tenantId,
    workflow_id: wfId,
    workflow_version_id: wfv!.id,
    status: i === 1 ? ("failed" as const) : ("succeeded" as const),
    request_source: i === 2 ? "wait_reaper" : "api",
    execution_mode: "prod" as const,
    started_at: new Date(baseStart.getTime() + i * 3_600_000),
    finished_at: new Date(baseStart.getTime() + i * 3_600_000 + durMs),
  }));
  await db.insert(executions).values(execValues);

  // Seed audit rows for connector stats.
  // Status codes: 200 (2xx), 401 (4xx_auth), 403 (4xx_auth), 429 (4xx_rate_limited)
  // Plus one result='error' + no status_code (network_error)
  const auditBase = new Date("2026-01-15T08:00:00.000Z");
  await db.insert(auditLog).values([
    {
      id: uuid(),
      ts: auditBase,
      tenant_id: srv.tenantId,
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: CONNECTOR_ID,
      result: "success",
      metadata: {
        connector_id: CONNECTOR_ID,
        connector_slug: "api-a",
        driver: "rest",
        method: "GET",
        status_code: "200",
        latency_ms: "100",
      },
    },
    {
      id: uuid(),
      ts: new Date(auditBase.getTime() + 1000),
      tenant_id: srv.tenantId,
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: CONNECTOR_ID,
      result: "denied",
      metadata: {
        connector_id: CONNECTOR_ID,
        connector_slug: "api-a",
        driver: "rest",
        method: "GET",
        status_code: "401",
        latency_ms: "50",
      },
    },
    {
      id: uuid(),
      ts: new Date(auditBase.getTime() + 2000),
      tenant_id: srv.tenantId,
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: CONNECTOR_ID,
      result: "denied",
      metadata: {
        connector_id: CONNECTOR_ID,
        connector_slug: "api-a",
        driver: "rest",
        method: "GET",
        status_code: "403",
        latency_ms: "50",
      },
    },
    {
      id: uuid(),
      ts: new Date(auditBase.getTime() + 3000),
      tenant_id: srv.tenantId,
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: CONNECTOR_ID,
      result: "error",
      metadata: {
        connector_id: CONNECTOR_ID,
        connector_slug: "api-a",
        driver: "rest",
        method: "GET",
        status_code: "429",
        latency_ms: "25",
      },
    },
    {
      id: uuid(),
      ts: new Date(auditBase.getTime() + 4000),
      tenant_id: srv.tenantId,
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: CONNECTOR_ID_2,
      result: "error",
      // No status_code → network_error
      metadata: {
        connector_id: CONNECTOR_ID_2,
        connector_slug: "api-b",
        driver: "rest",
        method: "POST",
        latency_ms: "10",
      },
    },
  ]);

  // Seed LLM usage rows.
  // Three rows: prompt=100, completion=50 each. Total tokens: 150 × 3 = 450.
  const llmBase = new Date("2026-01-15T08:00:00.000Z");
  await db.insert(llmUsage).values([
    {
      tenant_id: srv.tenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 10,
      cache_creation_tokens: 0,
      latency_ms: 500,
      result: "success",
      month_bucket: 202601,
      created_at: llmBase,
    },
    {
      tenant_id: srv.tenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 5,
      cache_creation_tokens: 0,
      latency_ms: 600,
      result: "success",
      month_bucket: 202601,
      created_at: new Date(llmBase.getTime() + 3_600_000), // +1h
    },
    {
      tenant_id: srv.tenantId,
      flow: "extract",
      model: "claude-sonnet-4-6",
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
      cache_read_tokens: 0,
      cache_creation_tokens: 20,
      latency_ms: 1200,
      result: "success",
      month_bucket: 202601,
      created_at: new Date(llmBase.getTime() + 2 * 3_600_000), // +2h
    },
  ]);
});

afterAll(async () => {
  await srv.cleanup();
});

function authedFetch(path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

// ---- Executions aggregation ------------------------------------------------

describe("executions aggregation", () => {
  test("window total = 3 executions", async () => {
    const res = await authedFetch(`/v1/stats/executions?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: {
        executions: { count: number; by_status: Record<string, number> };
        duration_ms: { total: number };
      };
    };
    expect(body.totals.executions.count).toBe(3);
  });

  test("duration_ms.total = Σ(finished_at - started_at)", async () => {
    const res = await authedFetch(`/v1/stats/executions?${WIN}`);
    const body = (await res.json()) as {
      totals: { duration_ms: { total: number } };
    };
    // Allow ±1ms rounding from float→int.
    expect(Math.abs(body.totals.duration_ms.total - TOTAL_EXEC_DURATION_MS)).toBeLessThanOrEqual(3);
  });

  test("by_status breakdown: 2 succeeded + 1 failed", async () => {
    const res = await authedFetch(`/v1/stats/executions?${WIN}`);
    const body = (await res.json()) as {
      totals: { executions: { by_status: Record<string, number> } };
    };
    expect(body.totals.executions.by_status.succeeded).toBe(2);
    expect(body.totals.executions.by_status.failed).toBe(1);
  });

  test("per-bucket bucket sum = window total (no double-counting)", async () => {
    const res = await authedFetch(`/v1/stats/executions?${WIN}`);
    const body = (await res.json()) as {
      groups: Array<{ buckets: Array<{ executions: number }> }>;
      totals: { executions: { count: number } };
    };
    const bucketSum = body.groups.flatMap((g) => g.buckets).reduce((s, b) => s + b.executions, 0);
    expect(bucketSum).toBe(body.totals.executions.count);
  });

  test("group_by=status: Σ group totals = window total", async () => {
    const res = await authedFetch(`/v1/stats/executions?${WIN}&group_by=status`);
    const body = (await res.json()) as {
      groups: Array<{ totals: { executions: number } }>;
      totals: { executions: { count: number } };
    };
    const groupSum = body.groups.reduce((s, g) => s + g.totals.executions, 0);
    expect(groupSum).toBe(body.totals.executions.count);
  });

  test("request_source=wait_reaper is accepted as an open-set value", async () => {
    const res = await authedFetch(`/v1/stats/executions?${WIN}&request_source=wait_reaper`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { executions: { count: number } };
    };
    // Only the 3rd execution uses wait_reaper.
    expect(body.totals.executions.count).toBe(1);
  });
});

// ---- Connector aggregation + status-class mapping --------------------------

describe("connector status-class mapping", () => {
  test("200 maps to 2xx, count=1", async () => {
    const res = await authedFetch(`/v1/stats/connectors?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: {
        calls: { total: number; by_status_class: Record<string, number> };
      };
    };
    expect(body.totals.calls.total).toBe(5);
    expect(body.totals.calls.by_status_class["2xx"]).toBe(1);
  });

  test("401 + 403 both map to 4xx_auth, count=2", async () => {
    const res = await authedFetch(`/v1/stats/connectors?${WIN}`);
    const body = (await res.json()) as {
      totals: { calls: { by_status_class: Record<string, number> } };
    };
    expect(body.totals.calls.by_status_class["4xx_auth"]).toBe(2);
  });

  test("429 maps to 4xx_rate_limited, count=1", async () => {
    const res = await authedFetch(`/v1/stats/connectors?${WIN}`);
    const body = (await res.json()) as {
      totals: { calls: { by_status_class: Record<string, number> } };
    };
    expect(body.totals.calls.by_status_class["4xx_rate_limited"]).toBe(1);
  });

  test("result=error + no status_code maps to network_error, count=1", async () => {
    const res = await authedFetch(`/v1/stats/connectors?${WIN}`);
    const body = (await res.json()) as {
      totals: { calls: { by_status_class: Record<string, number> } };
    };
    expect(body.totals.calls.by_status_class.network_error).toBe(1);
  });

  test("outcome breakdown: 1 success + 2 denied + 2 error", async () => {
    const res = await authedFetch(`/v1/stats/connectors?${WIN}`);
    const body = (await res.json()) as {
      totals: {
        calls: {
          by_outcome: { success: number; denied: number; error: number };
        };
      };
    };
    expect(body.totals.calls.by_outcome.success).toBe(1);
    expect(body.totals.calls.by_outcome.denied).toBe(2);
    expect(body.totals.calls.by_outcome.error).toBe(2);
  });

  test("Σ group totals by connector_id = window total", async () => {
    const res = await authedFetch(`/v1/stats/connectors?${WIN}&group_by=connector_id`);
    const body = (await res.json()) as {
      groups: Array<{ totals: { calls: { total: number } } }>;
      totals: { calls: { total: number } };
    };
    const groupSum = body.groups.reduce((s, g) => s + g.totals.calls.total, 0);
    expect(groupSum).toBe(body.totals.calls.total);
  });
});

// ---- LLM aggregation -------------------------------------------------------

describe("LLM aggregation", () => {
  test("window total = 3 calls", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(3);
  });

  test("token totals sum correctly: prompt=400 completion=200 total=600", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}`);
    const body = (await res.json()) as {
      totals: {
        tokens: {
          prompt: number;
          completion: number;
          total: number;
          cache_read: number;
          cache_creation: number;
        };
      };
    };
    expect(body.totals.tokens.prompt).toBe(400); // 100+100+200
    expect(body.totals.tokens.completion).toBe(200); // 50+50+100
    expect(body.totals.tokens.total).toBe(600); // 150+150+300
    expect(body.totals.tokens.cache_read).toBe(15); // 10+5+0
    expect(body.totals.tokens.cache_creation).toBe(20); // 0+0+20
  });

  test("group_by=model: Σ group totals = window total", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}&group_by=model`);
    const body = (await res.json()) as {
      groups: Array<{ totals: { calls: number } }>;
      totals: { calls: { total: number } };
    };
    const groupSum = body.groups.reduce((s, g) => s + g.totals.calls, 0);
    expect(groupSum).toBe(body.totals.calls.total);
  });

  test("group_by=model: each group carries its own cost, adding up to the window's", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}&group_by=model`);
    const body = (await res.json()) as {
      groups: Array<{ cost?: { amount: number; currency: string } }>;
      cost: { amount: number; currency: string };
    };
    expect(body.groups.every((g) => g.cost?.currency === body.cost.currency)).toBe(true);
    const groupSum = body.groups.reduce((s, g) => s + (g.cost?.amount ?? 0), 0);
    expect(groupSum).toBeCloseTo(body.cost.amount, 6);
  });

  test("two dimensions carry no per-group cost", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}&group_by=model,flow`);
    const body = (await res.json()) as { groups: Array<{ cost?: unknown }> };
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.groups.every((g) => g.cost === undefined)).toBe(true);
  });

  test("group_by=flow: haiku=2 calls, sonnet=1 call", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}&group_by=flow`);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string>; totals: { calls: number } }>;
    };
    const converseGroup = body.groups.find((g) => g.key.flow === "converse");
    const extractGroup = body.groups.find((g) => g.key.flow === "extract");
    expect(converseGroup?.totals.calls).toBe(2);
    expect(extractGroup?.totals.calls).toBe(1);
  });
});
