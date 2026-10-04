import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { ConfigSchema, ModelPriceSchema } from "../../config/schema.ts";
import { DEFAULT_MODEL_ID, knownContextModelIds } from "../core/ai-sdk-model.ts";
import { DEFAULT_FALLBACK_MODEL, DEFAULT_PRIMARY_MODEL } from "../core/invoke.ts";
import { DEFAULT_INIT_MODEL } from "../core/model-init.ts";
import { ladderModelIds, routeTop, routeUp } from "../core/step-router.ts";
import {
  effectiveModelPrices,
  MODEL_PRICE_CATALOG,
  MODEL_PRICE_CATALOG_CURRENCY,
} from "../model-price-catalog.ts";
import { bareModelId, priceCalls } from "../pricing.ts";
import type { LlmProviderKind } from "../types.ts";

const catalogIds = (): Set<string> => new Set(MODEL_PRICE_CATALOG.map((p) => p.model));
const isPriced = (model: string): boolean =>
  catalogIds().has(model) || catalogIds().has(bareModelId(model));

function configDefaultModelIds(): string[] {
  const parsed = ConfigSchema.parse({ database: { url: "postgres://x:y@127.0.0.1:5432/z" } });
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (/model$/.test(key) && typeof value === "string" && value.length > 0) found.push(value);
      else walk(value);
    }
  };
  walk(parsed);
  return found;
}

const LADDER_PROVIDERS: LlmProviderKind[] = ["anthropic", "openai", "gemini"];

function modelsSubKitChooses(): string[] {
  const seen = new Set<string>([
    ...configDefaultModelIds(),
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FALLBACK_MODEL,
    DEFAULT_MODEL_ID,
    DEFAULT_INIT_MODEL,
  ]);
  const queue = [...seen];
  while (queue.length > 0) {
    const model = queue.pop() as string;
    for (const provider of LADDER_PROVIDERS) {
      for (const next of [routeUp(provider, model), routeTop(provider, model)]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return [...seen].sort();
}

const KNOWN_BUT_UNPRICED = [
  "claude-3-5-sonnet",
  "claude-3-opus",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "o1-mini",
  "o1-preview",
];

describe("the catalog itself", () => {
  test("every entry is a valid tokens.prices entry, non-negative, with a traceable source", () => {
    for (const entry of MODEL_PRICE_CATALOG) {
      const { source, long_context, ...price } = entry;
      expect(ModelPriceSchema.parse(price)).toEqual(price);
      for (const rate of [
        price.input_per_mtok,
        price.output_per_mtok,
        price.cache_read_per_mtok,
        price.cache_write_per_mtok,
        ...(long_context
          ? [
              long_context.input_per_mtok,
              long_context.output_per_mtok,
              long_context.cache_read_per_mtok,
              long_context.cache_write_per_mtok,
            ]
          : []),
      ]) {
        expect(Number.isFinite(rate) && rate >= 0).toBe(true);
      }
      if (long_context) {
        expect(Number.isInteger(long_context.threshold_prompt_tokens)).toBe(true);
        expect(long_context.threshold_prompt_tokens).toBeGreaterThan(0);
        expect(long_context.input_per_mtok).toBeGreaterThan(price.input_per_mtok);
      }
      expect(source).toMatch(/^https:\/\//);
    }
  });

  test("names each model once", () => {
    const ids = MODEL_PRICE_CATALOG.map((p) => p.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("is quoted in US dollars", () => {
    expect(MODEL_PRICE_CATALOG_CURRENCY).toBe("USD");
  });
});

describe("every release stays priced", () => {
  test("the sources this guard reads are not empty", () => {
    expect(configDefaultModelIds().length).toBeGreaterThan(0);
    expect(modelsSubKitChooses()).toContain(DEFAULT_PRIMARY_MODEL);
    expect(ladderModelIds().length).toBeGreaterThan(0);
    expect(knownContextModelIds().length).toBeGreaterThan(0);
  });

  test("every model SubKit chooses on its own has a catalog price", () => {
    const unpriced = modelsSubKitChooses().filter((m) => !isPriced(m));
    expect(unpriced).toEqual([]);
  });

  test("the models SubKit knows but does not price are exactly the named list", () => {
    const known = new Set([...ladderModelIds(), ...knownContextModelIds()]);
    const unpriced = [...known].filter((m) => !isPriced(m)).sort();
    expect(unpriced).toEqual(KNOWN_BUT_UNPRICED);
  });
});

describe("effective prices", () => {
  test("with no overrides every catalog model is priced from the catalog", () => {
    const rates = effectiveModelPrices({ currency: "USD", prices: [] });
    expect(rates.map((r) => r.model).sort()).toEqual([...catalogIds()].sort());
    expect(rates.every((r) => r.price_source === "catalog")).toBe(true);
  });

  test("an operator entry replaces its model's catalog price and leaves the rest alone", () => {
    const rates = effectiveModelPrices({
      currency: "USD",
      prices: [
        {
          model: "claude-sonnet-4-6",
          input_per_mtok: 1,
          output_per_mtok: 2,
          cache_read_per_mtok: 0,
          cache_write_per_mtok: 0,
        },
      ],
    });
    const sonnet = rates.find((r) => r.model === "claude-sonnet-4-6");
    expect(sonnet).toMatchObject({
      input_per_mtok: 1,
      output_per_mtok: 2,
      price_source: "override",
    });
    const haiku = rates.find((r) => r.model === "claude-haiku-4-5");
    expect(haiku).toMatchObject({ input_per_mtok: 1, output_per_mtok: 5, price_source: "catalog" });
    expect(rates.filter((r) => r.model === "claude-sonnet-4-6")).toHaveLength(1);
  });

  test("an override on a base model also wins over the catalog's dated alias of it", () => {
    const result = priceCalls(
      [
        {
          model: "claude-haiku-4-5-20251001",
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      ],
      effectiveModelPrices({
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
      }),
      "USD",
    );
    expect(result.amount).toBeCloseTo(0.5, 6);
    expect(result.price_sources).toEqual([
      { model: "claude-haiku-4-5-20251001", price_source: "override" },
    ]);
  });

  test("a tenant in another currency is priced only by its own entries", () => {
    const rates = effectiveModelPrices({
      currency: "EUR",
      prices: [
        {
          model: "claude-haiku-4-5",
          input_per_mtok: 0.9,
          output_per_mtok: 4.6,
          cache_read_per_mtok: 0.09,
          cache_write_per_mtok: 1.15,
        },
      ],
    });
    expect(rates.map((r) => [r.model, r.price_source])).toEqual([["claude-haiku-4-5", "override"]]);
  });

  test("a model with neither an override nor a catalog price is reported unpriced", () => {
    const result = priceCalls(
      [
        {
          model: "some-new-model",
          calls: 7,
          prompt_tokens: 100,
          completion_tokens: 10,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      ],
      effectiveModelPrices({ currency: "USD", prices: [] }),
      "USD",
    );
    expect(result.amount).toBe(0);
    expect(result.unpriced_models).toEqual(["some-new-model"]);
    expect(result.unpriced_calls).toBe(7);
    expect(result.price_sources).toEqual([]);
  });

  test("a row with cache reads and writes is costed from the catalog", () => {
    const result = priceCalls(
      [
        {
          model: "claude-sonnet-4-6",
          prompt_tokens: 1_000_000,
          completion_tokens: 200_000,
          cache_read_tokens: 500_000,
          cache_creation_tokens: 100_000,
        },
      ],
      effectiveModelPrices({ currency: "USD", prices: [] }),
      "USD",
    );
    expect(result.amount).toBeCloseTo(4.95, 6);
    expect(result.unpriced_calls).toBe(0);
    expect(result.price_sources).toEqual([{ model: "claude-sonnet-4-6", price_source: "catalog" }]);
  });

  test("a provider-prefixed or date-stamped id finds its base model's price", () => {
    const rates = effectiveModelPrices({ currency: "USD", prices: [] });
    const row = {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    const result = priceCalls(
      [
        { ...row, model: "anthropic/claude-opus-4-8" },
        { ...row, model: "claude-sonnet-4-6-20260101" },
      ],
      rates,
      "USD",
    );
    expect(result.unpriced_models).toEqual([]);
    expect(result.amount).toBeCloseTo(8, 6);
  });

  test("a snapshot the vendor prices apart keeps its own price, not its base model's", () => {
    const result = priceCalls(
      [
        {
          model: "gpt-4o-2024-05-13",
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      ],
      effectiveModelPrices({ currency: "USD", prices: [] }),
      "USD",
    );
    expect(result.amount).toBeCloseTo(5, 6);
  });
});

describe("the catalog never reaches the stored configuration", () => {
  let dir: string;
  let cfgPath: string;
  const ENV = { DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NODE_ENV: "test" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sk-price-catalog-"));
    cfgPath = join(dir, "subkit.config.json");
    _resetConfigForTests();
  });

  afterEach(() => {
    _resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test("boot, pricing and a settings write leave tokens.prices empty", async () => {
    writeFileSync(cfgPath, JSON.stringify({ database: { url: ENV.DATABASE_URL } }));
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().tokens.prices).toEqual([]);

    const rates = effectiveModelPrices(getConfig().tokens);
    expect(rates.length).toBe(MODEL_PRICE_CATALOG.length);
    expect(getConfig().tokens.prices).toEqual([]);

    await setConfigKey(["tokens", "monthly_budget"], 1_000, { force: true });
    const stored = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      tokens?: { prices?: unknown[] };
    };
    expect(stored.tokens?.prices ?? []).toEqual([]);
    expect(getConfig().tokens.prices).toEqual([]);
  });
});

describe("Anthropic long context", () => {
  test("no Anthropic entry carries a long-context tier", () => {
    const claude = MODEL_PRICE_CATALOG.filter((p) => p.model.startsWith("claude-"));
    expect(claude.length).toBeGreaterThan(0);
    for (const price of claude) expect(price.long_context, price.model).toBeUndefined();
  });

  test("a 900k-token prompt on a 1M-window model is billed at the base rate", () => {
    const rates = effectiveModelPrices({});
    for (const [model, input, output] of [
      ["claude-sonnet-4-6", 3, 15],
      ["claude-opus-4-6", 5, 25],
      ["claude-opus-5-5", 4, 20],
    ] as const) {
      const result = priceCalls(
        [
          {
            model,
            prompt_tokens: 900_000,
            completion_tokens: 100_000,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
        ],
        rates,
        "USD",
      );
      expect(result.amount, model).toBeCloseTo(0.9 * input + 0.1 * output, 6);
    }
  });
});
