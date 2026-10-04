import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { tenants } from "../db/schema/identity.ts";
import { llmUsage } from "../db/schema/llm.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { effectiveModelPrices, longContextThresholds, priceCalls } from "../llm/index.ts";
import { readLlmCostByGroup, readLlmWindowCost, readPricedTokens } from "./llm-cost.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;

const TS = new Date("2024-01-01T12:00:00.000Z");

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("stats-llm-cost-tiers");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "llm-cost-tiers", display_name: "LLM Cost Tiers" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
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
    const byFlow = await readLlmCostByGroup(testDb.db, window, "flow");
    const whole = await readLlmWindowCost(testDb.db, window);
    expect([...byFlow.keys()].sort()).toEqual(["converse", "self_healing"]);
    const converse = byFlow.get("converse")?.amount ?? 0;
    const healing = byFlow.get("self_healing")?.amount ?? 0;
    expect(converse).toBeGreaterThan(0);
    expect(converse).toBeCloseTo(healing * 2, 6);
    expect(converse + healing).toBeCloseTo(whole.amount, 6);
  });

  test("a workflow grouping joins the run and files calls without one under an empty key", async () => {
    await seed("claude-haiku-4-5", [100_000]);
    const byWorkflow = await readLlmCostByGroup(
      testDb.db,
      {
        tenantId,
        bucket: "day",
        from: new Date("2024-01-01T00:00:00.000Z"),
        to: new Date("2024-01-02T00:00:00.000Z"),
        tz: "UTC",
      },
      "workflow",
    );
    expect([...byWorkflow.keys()]).toEqual([""]);
    expect(byWorkflow.get("")?.amount ?? 0).toBeGreaterThan(0);
  });
});
