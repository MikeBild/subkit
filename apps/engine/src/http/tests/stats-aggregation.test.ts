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

const FROM = "2026-01-15T00:00:00.000Z";
const TO = "2026-01-15T23:59:59.999Z";
const WIN = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

const CONNECTOR_ID = uuid();
const CONNECTOR_ID_2 = uuid();

const EXEC_DURATIONS_MS = [10_000, 20_000, 30_000];
const TOTAL_EXEC_DURATION_MS = EXEC_DURATIONS_MS.reduce((a, b) => a + b, 0);

let wfId = "";

beforeAll(async () => {
  srv = await createHttpTestServer("stats-agg");
  const db = srv.db;

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
      metadata: {
        connector_id: CONNECTOR_ID_2,
        connector_slug: "api-b",
        driver: "rest",
        method: "POST",
        latency_ms: "10",
      },
    },
  ]);

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
      created_at: new Date(llmBase.getTime() + 3_600_000),
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
      created_at: new Date(llmBase.getTime() + 2 * 3_600_000),
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
    expect(body.totals.executions.count).toBe(1);
  });
});

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
    expect(body.totals.tokens.prompt).toBe(400);
    expect(body.totals.tokens.completion).toBe(200);
    expect(body.totals.tokens.total).toBe(600);
    expect(body.totals.tokens.cache_read).toBe(15);
    expect(body.totals.tokens.cache_creation).toBe(20);
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

  test("group_by=model: each known model carries the name people know it by", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}&group_by=model`);
    const body = (await res.json()) as {
      groups: Array<{ key: { model?: string }; model_name?: string }>;
    };
    const names = Object.fromEntries(body.groups.map((g) => [g.key.model, g.model_name]));
    expect(names["claude-haiku-4-5"]).toBe("Claude Haiku 4.5");
    expect(names["claude-sonnet-4-6"]).toBe("Claude Sonnet 4.6");
  });

  test("two dimensions are priced per group, adding up to the window's cost", async () => {
    const res = await authedFetch(`/v1/stats/llm?${WIN}&group_by=model,flow`);
    const body = (await res.json()) as {
      groups: Array<{ cost?: { amount: number } }>;
      cost: { amount: number };
    };
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.groups.every((g) => g.cost !== undefined)).toBe(true);
    const groupSum = body.groups.reduce((s, g) => s + (g.cost?.amount ?? 0), 0);
    expect(groupSum).toBeCloseTo(body.cost.amount, 6);
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

describe("zero-filled buckets", () => {
  type Bucket = { ts: string; executions?: number; calls?: number };
  type Body = { groups: Array<{ key: Record<string, string>; buckets: Bucket[] }> };

  test("executions: every hour of the day is listed, empty hours carry zero", async () => {
    const body = (await (await authedFetch(`/v1/stats/executions?${WIN}`)).json()) as Body;
    expect(body.groups).toHaveLength(1);
    const buckets = body.groups[0]!.buckets;
    expect(buckets).toHaveLength(24);
    expect(buckets[0]!.ts).toBe("2026-01-15T00:00:00.000Z");
    expect(buckets[23]!.ts).toBe("2026-01-15T23:00:00.000Z");
    expect(buckets[0]!.executions).toBe(0);
    expect(buckets[8]!.executions).toBe(1);
  });

  test("executions: fill=none keeps only the buckets with data", async () => {
    const body = (await (
      await authedFetch(`/v1/stats/executions?${WIN}&fill=none`)
    ).json()) as Body;
    expect(body.groups[0]!.buckets).toHaveLength(3);
  });

  test("executions: a window without runs still yields one all-zero group", async () => {
    const empty = `bucket=day&from=${encodeURIComponent("2025-03-01T00:00:00.000Z")}&to=${encodeURIComponent("2025-03-08T00:00:00.000Z")}`;
    const body = (await (await authedFetch(`/v1/stats/executions?${empty}`)).json()) as Body;
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.buckets.map((b) => b.executions)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("executions: each group_by group is filled on its own", async () => {
    const body = (await (
      await authedFetch(`/v1/stats/executions?${WIN}&group_by=status`)
    ).json()) as Body;
    expect(body.groups.length).toBeGreaterThan(1);
    for (const group of body.groups) expect(group.buckets).toHaveLength(24);
  });

  test("llm: every hour is listed and the empty ones carry zero calls", async () => {
    const body = (await (await authedFetch(`/v1/stats/llm?${WIN}`)).json()) as Body;
    const buckets = body.groups[0]!.buckets;
    expect(buckets).toHaveLength(24);
    expect(buckets.reduce((sum, b) => sum + (b.calls ?? 0), 0)).toBe(3);
    expect(buckets.filter((b) => b.calls === 0).length).toBeGreaterThan(0);
  });
});
