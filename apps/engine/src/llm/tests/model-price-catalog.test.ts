// The built-in price catalog, and the guards that keep every release priced.
//
// Two promises are pinned here. First, the models SubKit chooses on its own —
// schema defaults, the invoke primary and fallback, the model-init default,
// and everything the step router escalates them to — always have a price, so
// a release that moves a default without pricing it fails here instead of in
// front of an operator. Second, the catalog is a read-time default: the
// operator's `tokens.prices` wins per model, and the catalog never lands in
// the stored configuration.

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

/** Every non-empty string the parsed default config holds under a key ending in `model`. */
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

/** The defaults plus every model the step router can escalate them to. */
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

/**
 * Models SubKit knows by name but ships no price for — the ladders' older
 * tiers and other vendors' models. Listed exactly: a new known model without
 * a price, or a price added without removing the name here, both fail.
 */
const KNOWN_BUT_UNPRICED = [
  "claude-3-5-haiku",
  "claude-3-5-sonnet",
  "claude-3-opus",
  "claude-opus-4-6",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gpt-4-turbo",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini",
  "o1-mini",
  "o1-preview",
];

describe("the catalog itself", () => {
  test("every entry is a valid tokens.prices entry, non-negative, with a traceable source", () => {
    for (const entry of MODEL_PRICE_CATALOG) {
      const { source, ...price } = entry;
      expect(ModelPriceSchema.parse(price)).toEqual(price);
      for (const rate of [
        price.input_per_mtok,
        price.output_per_mtok,
        price.cache_read_per_mtok,
        price.cache_write_per_mtok,
      ]) {
        expect(Number.isFinite(rate) && rate >= 0).toBe(true);
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
    // A guard over an empty list passes forever.
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
    // The catalog lists `claude-haiku-4-5-20251001` exactly. Without this, a
    // call recorded under the dated id would hit that catalog entry first and
    // never reach the operator's `claude-haiku-4-5` price.
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
    // 1M prompt = 400k uncached + 500k cache read + 100k cache write.
    // Sonnet 4.6: 0.4·3 + 0.5·0.30 + 0.1·3.75 + 0.2·15 = 1.2 + 0.15 + 0.375 + 3.0
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
    expect(result.amount).toBeCloseTo(4.725, 6);
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
    expect(result.amount).toBeCloseTo(8, 6); // 5 + 3
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

    // A settings write persists the in-memory config; the catalog must not
    // ride along into the file.
    await setConfigKey(["tokens", "monthly_budget"], 1_000, { force: true });
    const stored = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      tokens?: { prices?: unknown[] };
    };
    expect(stored.tokens?.prices ?? []).toEqual([]);
    expect(getConfig().tokens.prices).toEqual([]);
  });
});
