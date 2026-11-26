import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { llmUsage } from "../db/schema/llm.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { effectiveModelPrices, longContextThresholds, priceCalls } from "../llm/index.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { readLlmCostByKey, readLlmWindowCost, readPricedTokens } from "./llm-cost.ts";

const skip = testEnv.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;

const TS = new Date("2024-01-01T12:00:00.000Z");

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("stats-llm-cost-tiers");
  tenantId = (
    await seedTenant(testDb.db, { slug: "llm-cost-tiers", display_name: "LLM Cost Tiers" })
  ).id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(llmUsage);
}, 30_000);

async function seed(model: string, prompts: number[], completion = 0): Promise<void> {
  await testDb.db.insert(llmUsage).values(
    prompts.map((prompt_tokens) => ({
      tenant_id: tenantId,
      flow: "converse",
      model,
      prompt_tokens,
      completion_tokens: completion,
      total_tokens: prompt_tokens + completion,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 10,
      result: "success",
      created_at: TS,
      month_bucket: 202401,
    })),
  );
}

async function cost(): Promise<number> {
  const prices = effectiveModelPrices({ currency: "USD", prices: [] });
  const rows = await readPricedTokens(
    testDb.db,
    sql`llm_usage.tenant_id = ${tenantId}`,
    longContextThresholds(prices),
  );
  return priceCalls(rows, prices, "USD").amount;
}

describe.skipIf(skip)("long-context split in the cost query", () => {
  test("two short gemini-2.5-pro calls whose sum passes 200k stay at the base rate", async () => {
    await seed("gemini-2.5-pro", [150_000, 150_000]);
    expect(await cost()).toBeCloseTo(0.3 * 1.25, 6);
  });

  test("a call exactly at the threshold is short; one past it is long", async () => {
    await seed("gemini-2.5-pro", [200_000, 250_000]);
    expect(await cost()).toBeCloseTo(0.2 * 1.25 + 0.25 * 2.5, 6);
  });

  test("a prompt past gemini's threshold but under gpt-5.6-sol's is short for gpt-5.6-sol", async () => {
    await seed("gpt-5.6-sol", [250_000, 300_000], 10_000);
    expect(await cost()).toBeCloseTo(0.25 * 4 + 0.01 * 20 + 0.3 * 8 + 0.01 * 30, 6);
  });

  test("models without a tier are summed as before", async () => {
    await seed("claude-haiku-4-5", [300_000, 400_000]);
    const prices = effectiveModelPrices({ currency: "USD", prices: [] });
    const rows = await readPricedTokens(
      testDb.db,
      sql`llm_usage.tenant_id = ${tenantId}`,
      longContextThresholds(prices),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.calls).toBe(2);
    expect(await cost()).toBeCloseTo(0.7 * 1, 6);
  });
});

describe.skipIf(skip)("cost per group", () => {
  let configDir = "";
  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), "subkit-llm-cost-test-"));
    _resetConfigForTests();
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/llm-cost", NODE_ENV: "test" },
      configPathOverride: join(configDir, "subkit.config.json"),
    });
  });
  afterAll(() => {
    _resetConfigForTests();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("each group is priced from its own rows and the groups add up to the window", async () => {
    await seed("claude-haiku-4-5", [100_000]);
    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "self_healing",
      model: "claude-haiku-4-5",
      prompt_tokens: 50_000,
      completion_tokens: 0,
      total_tokens: 50_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 10,
      result: "success",
      created_at: TS,
      month_bucket: 202401,
    });
    const window = {
      tenantId,
      bucket: "day" as const,
      from: new Date("2024-01-01T00:00:00.000Z"),
      to: new Date("2024-01-02T00:00:00.000Z"),
      tz: "UTC",
    };
    const byFlow = (await readLlmCostByKey(testDb.db, window, ["flow"])).groups;
    const whole = await readLlmWindowCost(testDb.db, window);
    expect([...byFlow.keys()].sort()).toEqual(["flow=converse", "flow=self_healing"]);
    const converse = byFlow.get("flow=converse")?.amount ?? 0;
    const healing = byFlow.get("flow=self_healing")?.amount ?? 0;
    expect(converse).toBeGreaterThan(0);
    expect(converse).toBeCloseTo(healing * 2, 6);
    expect(converse + healing).toBeCloseTo(whole.amount, 6);
  });

  test("dictation shows up in the flow breakdown, priced per audio minute", async () => {
    await seed("claude-haiku-4-5", [100_000]);
    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "transcription",
      model: "openai/gpt-4o-mini-transcribe",
      audio_seconds: 120,
      latency_ms: 900,
      result: "success",
      created_at: TS,
      month_bucket: 202401,
    });
    const window = {
      tenantId,
      bucket: "day" as const,
      from: new Date("2024-01-01T00:00:00.000Z"),
      to: new Date("2024-01-02T00:00:00.000Z"),
      tz: "UTC",
    };
    const byFlow = (await readLlmCostByKey(testDb.db, window, ["flow"])).groups;
    expect([...byFlow.keys()].sort()).toEqual(["flow=converse", "flow=transcription"]);
    const dictation = byFlow.get("flow=transcription");
    expect(dictation?.amount).toBeCloseTo(0.006, 6);
    expect(dictation?.unpriced_calls).toBe(0);
    const whole = await readLlmWindowCost(testDb.db, window);
    expect(whole.amount).toBeCloseTo((byFlow.get("flow=converse")?.amount ?? 0) + 0.006, 6);
  });

  test("a workflow grouping joins the run and files calls without one under an empty key", async () => {
    await seed("claude-haiku-4-5", [100_000]);
    const byWorkflow = (
      await readLlmCostByKey(
        testDb.db,
        {
          tenantId,
          bucket: "day",
          from: new Date("2024-01-01T00:00:00.000Z"),
          to: new Date("2024-01-02T00:00:00.000Z"),
          tz: "UTC",
        },
        ["workflow"],
      )
    ).groups;
    expect([...byWorkflow.keys()]).toEqual(["workflow="]);
    expect(byWorkflow.get("workflow=")?.amount ?? 0).toBeGreaterThan(0);
  });

  const DAY = {
    bucket: "day" as const,
    from: new Date("2024-01-01T00:00:00.000Z"),
    to: new Date("2024-01-03T00:00:00.000Z"),
    tz: "UTC",
  };

  async function row(values: {
    flow?: string;
    model?: string;
    prompt?: number;
    completion?: number;
    cacheRead?: number;
    result?: string;
    at?: Date;
    conversationId?: string;
  }): Promise<void> {
    const prompt = values.prompt ?? 100_000;
    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: values.flow ?? "converse",
      model: values.model ?? "claude-haiku-4-5",
      prompt_tokens: prompt,
      completion_tokens: values.completion ?? 0,
      total_tokens: prompt + (values.completion ?? 0),
      cache_read_tokens: values.cacheRead ?? 0,
      cache_creation_tokens: 0,
      latency_ms: 10,
      result: values.result ?? "success",
      created_at: values.at ?? TS,
      month_bucket: 202401,
      conversation_id: values.conversationId ?? null,
    });
  }

  test("two dimensions and each day are priced, and the days add up to the group", async () => {
    await row({ flow: "converse", at: new Date("2024-01-01T08:00:00.000Z") });
    await row({ flow: "converse", at: new Date("2024-01-02T08:00:00.000Z"), prompt: 300_000 });
    await row({ flow: "summarize", model: "gpt-4o-mini" });
    const keyed = await readLlmCostByKey(testDb.db, { tenantId, ...DAY }, ["flow", "model"]);
    const group = keyed.groups.get("flow=converse|model=claude-haiku-4-5");
    expect(group?.amount).toBeCloseTo(0.4, 6);
    const first = keyed.buckets.get(
      "flow=converse|model=claude-haiku-4-5@@2024-01-01T00:00:00.000Z",
    );
    const second = keyed.buckets.get(
      "flow=converse|model=claude-haiku-4-5@@2024-01-02T00:00:00.000Z",
    );
    expect(first?.amount).toBeCloseTo(0.1, 6);
    expect(second?.amount).toBeCloseTo(0.3, 6);
    expect(keyed.groups.get("flow=summarize|model=gpt-4o-mini")?.amount).toBeCloseTo(0.015, 6);
  });

  test("cache savings use the same rate as the cost", async () => {
    await row({ prompt: 1_000_000, cacheRead: 600_000 });
    const window = await readLlmWindowCost(testDb.db, { tenantId, ...DAY });
    expect(window.amount).toBeCloseTo(0.4 + 0.06, 6);
    expect(window.cache_savings).toBeCloseTo(0.6 * (1 - 0.1), 6);
  });

  test("a result filter prices only failed calls, and a failure without tokens costs nothing", async () => {
    await row({ result: "success" });
    await row({ result: "error", prompt: 200_000, completion: 1_000 });
    await row({ result: "context_too_large", prompt: 0 });
    const failed = await readLlmWindowCost(testDb.db, {
      tenantId,
      ...DAY,
      result: ["error", "context_too_large", "quota_exhausted"],
    });
    expect(failed.amount).toBeCloseTo(0.2 + 0.005, 6);
  });

  test("calls are grouped by conversation, and calls outside one share an empty key", async () => {
    const id = "6f1c1b54-8a8f-4b55-9a51-5d1f4d0b7c11";
    await row({ conversationId: id });
    await row({ flow: "workflow_step" });
    const keyed = await readLlmCostByKey(testDb.db, { tenantId, ...DAY }, ["conversation"]);
    expect([...keyed.groups.keys()].sort()).toEqual(["conversation=", `conversation=${id}`]);
    expect(keyed.groups.get(`conversation=${id}`)?.amount).toBeCloseTo(0.1, 6);
  });
});
