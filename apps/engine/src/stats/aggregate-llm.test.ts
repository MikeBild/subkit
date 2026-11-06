import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { executions } from "../db/schema/executions.ts";
import { llmUsage } from "../db/schema/llm.ts";
import { workflows } from "../db/schema/workflows.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { aggregateLlm } from "./aggregate-llm.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;

const FROM = new Date("2024-01-01T00:00:00.000Z");
const TO = new Date("2024-01-02T00:00:00.000Z");
const INSIDE_TS = new Date("2024-01-01T12:00:00.000Z");

function monthBucket(d: Date): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

beforeAll(async () => {
  if (skip) return;

  testDb = await createTestDb("stats-agg-llm");

  tenantId = (
    await seedTenant(testDb.db, { slug: "stats-llm-tenant", display_name: "Stats LLM Tenant" })
  ).id;

  otherTenantId = (
    await seedTenant(testDb.db, { slug: "stats-llm-other", display_name: "Stats LLM Other" })
  ).id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(llmUsage);
}, 30_000);

describe.skipIf(skip)("aggregateLlm", () => {
  test("empty window → zero totals and synthetic group with no buckets", async () => {
    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.calls.total).toBe(0);
    expect(result.totals.calls.by_result).toEqual({});
    expect(result.totals.tokens.total).toBe(0);
    expect(result.totals.latency_ms.total).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.buckets).toHaveLength(0);
  });

  test("two LLM calls → total count 2 and by_result exact", async () => {
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 200,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 80,
        completion_tokens: 20,
        total_tokens: 100,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 100,
        result: "failure",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
    ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.calls.total).toBe(2);
    expect(result.totals.calls.by_result).toEqual({ success: 1, failure: 1 });
    expect(result.totals.tokens.total).toBe(250);
    expect(result.totals.tokens.prompt).toBe(180);
    expect(result.totals.tokens.completion).toBe(70);
    expect(result.totals.latency_ms.total).toBeGreaterThan(0);
  });

  test("group_by model produces per-model group keys", async () => {
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 200,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
      {
        tenant_id: tenantId,
        flow: "repair",
        model: "claude-sonnet-4-6",
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 400,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
    ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["model"],
    });

    expect(result.groups).toHaveLength(2);
    const modelKeys = result.groups.map((g) => g.key.model).sort();
    expect(modelKeys).toContain("claude-haiku-4-5");
    expect(modelKeys).toContain("claude-sonnet-4-6");

    const haikuGroup = result.groups.find((g) => g.key.model === "claude-haiku-4-5")!;
    expect(haikuGroup.totals.calls).toBe(1);
    expect(haikuGroup.totals.tokens.total).toBe(150);
  });

  test("group_by workflow attributes spend to the workflow that ran the call", async () => {
    const [wf] = await testDb.db
      .insert(workflows)
      .values({ tenant_id: tenantId, slug: "editorial", name: "Editorial", lifecycle: "active" })
      .returning();
    const [exec] = await testDb.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf!.id,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
      })
      .returning();

    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "workflow_step",
        model: "claude-fable-5",
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 900,
        result: "success",
        execution_id: exec!.id,
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-fable-5",
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 20,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
    ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["workflow"],
    });

    const attributed = result.groups.find((g) => g.key.workflow === wf!.id);
    expect(attributed).toBeDefined();
    expect(attributed!.totals.calls).toBe(1);
    expect(attributed!.totals.tokens.total).toBe(1500);

    const orphan = result.groups.find((g) => g.key.workflow === "");
    expect(orphan).toBeDefined();
    expect(orphan!.totals.calls).toBe(1);

    expect(result.totals.calls.total).toBe(2);
  });

  test("group_by flow produces per-flow group keys", async () => {
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 200,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
      {
        tenant_id: tenantId,
        flow: "repair",
        model: "claude-haiku-4-5",
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 300,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
    ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["flow"],
    });

    expect(result.groups).toHaveLength(2);
    const flowKeys = result.groups.map((g) => g.key.flow).sort();
    expect(flowKeys).toContain("converse");
    expect(flowKeys).toContain("repair");
  });

  test("tenant isolation — wrong tenant returns zero", async () => {
    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 200,
      result: "success",
      created_at: INSIDE_TS,
      month_bucket: monthBucket(INSIDE_TS),
    });

    const result = await aggregateLlm(testDb.db, {
      tenantId: otherTenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.calls.total).toBe(0);
    expect(result.groups[0]!.totals.calls).toBe(0);
    expect(result.groups[0]!.buckets).toHaveLength(0);
  });

  test("by_result is exact — no phantom result values", async () => {
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 50,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 50,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 50,
        result: "failure",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      },
    ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.calls.by_result).toEqual({ success: 2, failure: 1 });
    expect(Object.keys(result.totals.calls.by_result).length).toBe(2);
  });

  test("latency percentiles are computed and ordered", async () => {
    const latencies = [100, 200, 300, 400, 500];
    await testDb.db.insert(llmUsage).values(
      latencies.map((lat) => ({
        tenant_id: tenantId,
        flow: "converse",
        model: "claude-haiku-4-5",
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: lat,
        result: "success",
        created_at: INSIDE_TS,
        month_bucket: monthBucket(INSIDE_TS),
      })),
    );

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    const lat = result.totals.latency_ms;
    expect(lat.p50).toBeGreaterThan(0);
    expect(lat.p95).toBeGreaterThanOrEqual(lat.p50);
    expect(lat.p99).toBeGreaterThanOrEqual(lat.p95);
    expect(lat.max).toBeGreaterThanOrEqual(lat.p99);
  });
});
