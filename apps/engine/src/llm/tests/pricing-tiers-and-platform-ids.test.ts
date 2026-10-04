import { describe, expect, test } from "bun:test";
import { PROMPT_CACHE_TTL } from "../core/cache-blocks.ts";
import { routeTop, routeUp } from "../core/step-router.ts";
import {
  ANTHROPIC_ONE_HOUR_CACHE_WRITE_MULTIPLIER,
  effectiveModelPrices,
  MODEL_PRICE_CATALOG,
} from "../model-price-catalog.ts";
import {
  bareModelId,
  CACHE_CREATE_WEIGHT,
  longContextThresholds,
  type PricedTokens,
  priceCalls,
  vendorModelId,
  weightedTotalTokens,
} from "../pricing.ts";

const catalog = () => effectiveModelPrices({ currency: "USD", prices: [] });

const row = (model: string, over: Partial<PricedTokens> = {}): PricedTokens => ({
  model,
  prompt_tokens: 1_000_000,
  completion_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  ...over,
});

describe("cache writes are priced at the TTL SubKit writes", () => {
  test("the engine writes the one-hour cache, which the catalog assumes", () => {
    expect(PROMPT_CACHE_TTL).toBe("1h");
    expect(ANTHROPIC_ONE_HOUR_CACHE_WRITE_MULTIPLIER).toBe(2);
  });

  test("every Anthropic catalog entry charges a cache write at 2x its input rate", () => {
    const anthropic = MODEL_PRICE_CATALOG.filter((p) => p.source.includes("claude.com"));
    expect(anthropic.length).toBeGreaterThan(0);
    for (const p of anthropic) {
      expect({ model: p.model, write: p.cache_write_per_mtok }).toEqual({
        model: p.model,
        write: p.input_per_mtok * 2,
      });
    }
  });

  test("the published one-hour rates", () => {
    const write = (model: string) =>
      MODEL_PRICE_CATALOG.find((p) => p.model === model)?.cache_write_per_mtok;
    expect(write("claude-haiku-4-5")).toBe(2);
    expect(write("claude-sonnet-4-6")).toBe(6);
    expect(write("claude-opus-4-8")).toBe(10);
    expect(write("claude-3-5-haiku")).toBe(1.6);
    expect(write("claude-fable-5-1")).toBe(20);
    expect(write("claude-opus-5-5")).toBe(8);
    expect(write("claude-sonnet-5")).toBe(4);
  });

  test("OpenAI and Google cache writes stay at the input rate", () => {
    for (const model of ["gpt-4o", "gpt-4.1", "gemini-2.5-flash"]) {
      const p = MODEL_PRICE_CATALOG.find((e) => e.model === model);
      expect(p?.cache_write_per_mtok).toBe(p?.input_per_mtok);
    }
  });

  test("the budget ledger weights a cache write at the one-hour rate too", () => {
    expect(CACHE_CREATE_WEIGHT).toBe(2);
    expect(
      weightedTotalTokens({
        prompt_tokens: 1000,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 1000,
      }),
    ).toBe(2000);
  });
});

describe("long-context tiers", () => {
  test("the catalog lists the tiers with their thresholds", () => {
    expect(longContextThresholds(catalog())).toEqual([200_000, 272_000]);
  });

  test("a single call past the threshold is priced at the long-context rate in full", () => {
    const result = priceCalls(
      [row("gemini-2.5-pro", { prompt_tokens: 250_000, completion_tokens: 10_000 })],
      catalog(),
      "USD",
    );
    expect(result.amount).toBeCloseTo(0.25 * 2.5 + 0.01 * 15, 6);
  });

  test("a call exactly at the threshold is priced at the base rate", () => {
    const result = priceCalls(
      [row("gemini-2.5-pro", { prompt_tokens: 200_000 })],
      catalog(),
      "USD",
    );
    expect(result.amount).toBeCloseTo(0.2 * 1.25, 6);
  });

  test("summed short calls never reach the long-context rate", () => {
    const result = priceCalls(
      [row("gemini-2.5-pro", { calls: 2, prompt_tokens: 300_000 })],
      catalog(),
      "USD",
    );
    expect(result.amount).toBeCloseTo(0.3 * 1.25, 6);
  });

  test("a row whose calls all exceeded the threshold is priced long, cache rates included", () => {
    const result = priceCalls(
      [
        row("gpt-5.6-sol", {
          calls: 2,
          prompt_tokens: 600_000,
          cache_read_tokens: 200_000,
          cache_creation_tokens: 100_000,
          completion_tokens: 100_000,
          prompt_tokens_exceed: 272_000,
        }),
      ],
      catalog(),
      "USD",
    );
    expect(result.amount).toBeCloseTo(0.3 * 8 + 0.2 * 0.8 + 0.1 * 10 + 0.1 * 30, 6);
  });

  test("a row that exceeded only a lower model's threshold stays at the base rate", () => {
    const result = priceCalls(
      [row("gpt-5.6-sol", { calls: 3, prompt_tokens: 750_000, prompt_tokens_exceed: 200_000 })],
      catalog(),
      "USD",
    );
    expect(result.amount).toBeCloseTo(0.75 * 4, 6);
  });

  test("an operator's rate is flat: no long-context tier is inherited from the catalog", () => {
    const rates = effectiveModelPrices({
      currency: "USD",
      prices: [
        {
          model: "gemini-2.5-pro",
          input_per_mtok: 1,
          output_per_mtok: 1,
          cache_read_per_mtok: 0,
          cache_write_per_mtok: 1,
        },
      ],
    });
    const result = priceCalls([row("gemini-2.5-pro", { prompt_tokens: 250_000 })], rates, "USD");
    expect(result.amount).toBeCloseTo(0.25, 6);
    expect(longContextThresholds(rates)).toEqual([272_000]);
  });
});

describe("cloud platform model ids", () => {
  test.each([
    ["anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"],
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"],
    ["eu.anthropic.claude-sonnet-4-6-v1", "claude-sonnet-4-6"],
    ["apac.anthropic.claude-opus-4-8-v2:0", "claude-opus-4-8"],
    ["global.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
    ["bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"],
    ["claude-haiku-4-5@20251001", "claude-haiku-4-5"],
    ["vertex/claude-opus-4-8@20260101", "claude-opus-4-8"],
  ])("%s reduces to %s", (id, bare) => {
    expect(bareModelId(id)).toBe(bare);
  });

  test.each(["gpt-5.6-sol", "gemini-2.5-pro", "gpt-4.1-mini"])(
    "a dotted vendor id %s is left alone",
    (id) => {
      expect(bareModelId(id)).toBe(id);
      expect(vendorModelId(id)).toBe(id);
    },
  );

  test("a Bedrock id is priced from the catalog and reported as normalized", () => {
    const result = priceCalls(
      [row("us.anthropic.claude-haiku-4-5-20251001-v1:0"), row("claude-haiku-4-5@20251001")],
      catalog(),
      "USD",
    );
    expect(result.unpriced_models).toEqual([]);
    expect(result.amount).toBeCloseTo(2, 6);
    expect(result.price_sources).toEqual([
      { model: "claude-haiku-4-5@20251001", price_source: "catalog_normalized" },
      { model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", price_source: "catalog_normalized" },
    ]);
  });

  test("the vendor's own spellings stay plain catalog prices", () => {
    const result = priceCalls(
      [row("claude-haiku-4-5"), row("anthropic/claude-sonnet-4-6-20260101")],
      catalog(),
      "USD",
    );
    expect(result.price_sources.map((s) => s.price_source)).toEqual(["catalog", "catalog"]);
  });

  test("an exact entry still wins over its base model", () => {
    const result = priceCalls([row("gpt-4o-2024-05-13")], catalog(), "USD");
    expect(result.amount).toBeCloseTo(5, 6);
    expect(result.price_sources).toEqual([{ model: "gpt-4o-2024-05-13", price_source: "catalog" }]);
  });

  test("an override under the exact platform id wins and is reported as the operator's", () => {
    const bedrock = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
    const rates = effectiveModelPrices({
      currency: "USD",
      prices: [
        {
          model: bedrock,
          input_per_mtok: 1.1,
          output_per_mtok: 5.5,
          cache_read_per_mtok: 0.11,
          cache_write_per_mtok: 2.2,
        },
      ],
    });
    const result = priceCalls([row(bedrock), row("claude-haiku-4-5")], rates, "USD");
    expect(result.amount).toBeCloseTo(1.1 + 1, 6);
    expect(result.price_sources).toEqual([
      { model: "claude-haiku-4-5", price_source: "catalog" },
      { model: bedrock, price_source: "override" },
    ]);
  });

  test("an override on the base model prices platform ids as the operator's rate", () => {
    const rates = effectiveModelPrices({
      currency: "USD",
      prices: [
        {
          model: "claude-haiku-4-5",
          input_per_mtok: 0.5,
          output_per_mtok: 2,
          cache_read_per_mtok: 0,
          cache_write_per_mtok: 0,
        },
      ],
    });
    const result = priceCalls([row("anthropic.claude-haiku-4-5-20251001-v1:0")], rates, "USD");
    expect(result.amount).toBeCloseTo(0.5, 6);
    expect(result.price_sources[0]?.price_source).toBe("override");
  });
});

describe("platform reduction stays a pricing concern", () => {
  test("routing never hands a Bedrock provider a direct-API model id", () => {
    const id = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    expect(routeUp("bedrock", id)).toBe(id);
    expect(routeTop("bedrock", id)).toBe(id);
  });
});
