// Integration test: the cost query splits calls at long-context thresholds
// per `llm_usage` row, before summing.
//
// A vendor bills a call whose prompt passes its long-context threshold at the
// higher rate in full. Summing a model's tokens first and comparing the sum
// would price two 150k prompts (300k together) as long, and a mix of short
// and long calls as all-short or all-long. The query groups by model and by
// how many thresholds each row exceeds, in one pass.
//
// Requires a real Postgres database — set REQUIRES_PG=0 to skip.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { tenants } from "../db/schema/identity.ts";
import { llmUsage } from "../db/schema/llm.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { effectiveModelPrices, longContextThresholds, priceCalls } from "../llm/index.ts";
import { readPricedTokens } from "./llm-cost.ts";

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
    // 250k: base (4 in, 20 out); 300k: long (8 in, 30 out).
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
    // Both rows exceed both cut points, so they land in one group.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.calls).toBe(2);
    expect(await cost()).toBeCloseTo(0.7 * 1, 6);
  });
});
