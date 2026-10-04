import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { llmUsage, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { recordUsage } from "../llm/accounting/index.ts";
import { type CostResult, priceCalls, type SourcedModelPrice } from "../llm/index.ts";
import { readPricedTokens } from "../stats/llm-cost.ts";
import { conversationUsageFrom, readConversationUsage } from "./usage.ts";

function cost(overrides: Partial<CostResult>): CostResult {
  return {
    amount: 0,
    currency: "EUR",
    unpriced_models: [],
    unpriced_calls: 0,
    price_sources: [],
    rates_basis: "current",
    ...overrides,
  };
}

describe("conversationUsageFrom", () => {
  test("a conversation without calls has no tokens and no cost", () => {
    expect(conversationUsageFrom([], cost({}))).toEqual({ tokens: 0, by_model: [], cost: null });
  });

  test("fully priced: the amount, with nothing unpriced", () => {
    const usage = conversationUsageFrom(
      [
        { model: "a", calls: 2, total_tokens: 300 },
        { model: "b", calls: 1, total_tokens: 700 },
      ],
      cost({ amount: 3 }),
    );
    expect(usage.tokens).toBe(1000);
    expect(usage.by_model).toEqual([
      { model: "b", tokens: 700 },
      { model: "a", tokens: 300 },
    ]);
    expect(usage.cost).toEqual({ amount: 3, currency: "EUR", unpriced_models: [] });
  });

  test("fully unpriced: no amount at all, never a zero that reads as free", () => {
    const usage = conversationUsageFrom(
      [{ model: "x", calls: 4, total_tokens: 500 }],
      cost({ unpriced_models: ["x"], unpriced_calls: 4 }),
    );
    expect(usage.tokens).toBe(500);
    expect(usage.cost).toBeNull();
  });

  test("partly priced: the amount names what it does not cover", () => {
    const usage = conversationUsageFrom(
      [
        { model: "a", calls: 1, total_tokens: 100 },
        { model: "x", calls: 3, total_tokens: 900 },
      ],
      cost({ amount: 1, unpriced_models: ["x"], unpriced_calls: 3 }),
    );
    expect(usage.cost).toEqual({ amount: 1, currency: "EUR", unpriced_models: ["x"] });
  });
});

const skip = process.env.REQUIRES_PG === "0";

const PRICES: SourcedModelPrice[] = [
  {
    model: "a",
    input_per_mtok: 1,
    output_per_mtok: 0,
    cache_read_per_mtok: 0,
    cache_write_per_mtok: 0,
    price_source: "catalog",
  },
];

async function priceRows(db: Db, _tenantId: string, where: SQL): Promise<CostResult> {
  return priceCalls(await readPricedTokens(db, where, []), PRICES, "EUR");
}

describe.skipIf(skip)("readConversationUsage", () => {
  let ctx: TestDb;
  let tenantA: string;
  let tenantB: string;
  const conversation = "0190f6a2-0000-7000-8000-00000000c0a1";
  const other = "0190f6a2-0000-7000-8000-00000000c0a2";

  beforeAll(async () => {
    ctx = await createTestDb("conversation-usage");
    const inserted = await ctx.db
      .insert(tenants)
      .values([
        { slug: "t-conv-usage-a", display_name: "Usage A" },
        { slug: "t-conv-usage-b", display_name: "Usage B" },
      ])
      .returning({ id: tenants.id });
    tenantA = inserted[0]?.id ?? "";
    tenantB = inserted[1]?.id ?? "";
    const row = (tenant: string, conversationId: string, model: string, tokens: number) => ({
      tenant_id: tenant,
      conversation_id: conversationId,
      model,
      prompt_tokens: tokens,
      total_tokens: tokens,
      flow: "converse",
      completion_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 1,
      result: "success",
      month_bucket: 202609,
    });
    await ctx.db
      .insert(llmUsage)
      .values([
        row(tenantA, conversation, "a", 1_000_000),
        row(tenantA, conversation, "a", 500_000),
        row(tenantA, conversation, "x", 25),
        row(tenantA, other, "a", 9_000_000),
        row(tenantB, conversation, "a", 7_000_000),
      ]);
    await recordUsage(
      {
        tenant_id: tenantA,
        conversation_id: conversation,
        flow: "converse",
        model: "a",
        prompt_tokens: 2_000_000,
        completion_tokens: 0,
        latency_ms: 0,
        result: "error",
        error: "You have reached your specified API usage limits",
      },
      ctx.db,
    );
  }, 60_000);

  afterAll(async () => {
    if (ctx?.cleanup) await ctx.cleanup();
  }, 30_000);

  test("sums and prices this tenant's rows for this conversation, per model — a refused call adds nothing", async () => {
    const usage = await readConversationUsage(ctx.db, tenantA, conversation, priceRows);
    expect(usage.tokens).toBe(1_500_025);
    expect(usage.by_model).toEqual([
      { model: "a", tokens: 1_500_000 },
      { model: "x", tokens: 25 },
    ]);
    expect(usage.cost).toEqual({ amount: 1.5, currency: "EUR", unpriced_models: ["x"] });
  });

  test("the same conversation id under another tenant reads that tenant's rows only", async () => {
    const usage = await readConversationUsage(ctx.db, tenantB, conversation, priceRows);
    expect(usage.tokens).toBe(7_000_000);
    expect(usage.cost?.amount).toBe(7);
  });
});
