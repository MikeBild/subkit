import { describe, expect, test } from "bun:test";
import {
  CATALOG_MODEL_PROVIDERS,
  MODEL_BADGE_OUTPUT_PRICE,
  modelCatalogView,
} from "../model-catalog-view.ts";

const price = (model: string, input: number, output: number) => ({
  model,
  input_per_mtok: input,
  output_per_mtok: output,
  cache_read_per_mtok: 0,
  cache_write_per_mtok: 0,
});

describe("modelCatalogView", () => {
  test("recommends exactly one model per catalog provider", () => {
    const { models } = modelCatalogView({});
    for (const provider of CATALOG_MODEL_PROVIDERS) {
      const recommended = models.filter((m) => m.provider === provider && m.badges.recommended);
      expect(recommended.map((m) => m.model)).toHaveLength(1);
    }
    expect(models.filter((m) => m.badges.recommended).map((m) => m.model)).toEqual([
      "claude-sonnet-5",
      "gemini-2.5-flash",
      "gpt-4.1-mini",
    ]);
  });

  test("pins the badge rule at the output price thresholds", () => {
    const { economicalAtMost, capableAtLeast } = MODEL_BADGE_OUTPUT_PRICE;
    const { models } = modelCatalogView({
      prices: [
        price("gpt-4o", 1, economicalAtMost),
        price("gpt-4.1", 1, economicalAtMost + 0.01),
        price("gpt-4o-mini", 1, capableAtLeast - 0.01),
        price("gpt-4.1-mini", 1, capableAtLeast),
      ],
    });
    const badges = (id: string) => models.find((m) => m.model === id)?.badges;
    expect(badges("gpt-4o")).toMatchObject({ economical: true, capable: false });
    expect(badges("gpt-4.1")).toMatchObject({ economical: false, capable: false });
    expect(badges("gpt-4o-mini")).toMatchObject({ economical: false, capable: false });
    expect(badges("gpt-4.1-mini")).toMatchObject({ economical: false, capable: true });
  });

  test("drops dated duplicates and unnamed catalog ids", () => {
    const ids = modelCatalogView({}).models.map((m) => m.model);
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).not.toContain("claude-haiku-4-5-20251001");
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("gpt-4o-2024-05-13");
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of modelCatalogView({}).models) {
      expect(entry.display_name).not.toBe(entry.model);
      expect(entry.price_source).toBe("catalog");
    }
  });

  test("an override flips the price source and replaces the built-in entry", () => {
    const { models } = modelCatalogView({
      prices: [price("claude-haiku-4-5-20251001", 0.5, 2)],
    });
    const haiku = models.filter((m) => m.display_name === "Claude Haiku 4.5");
    expect(haiku).toHaveLength(1);
    expect(haiku[0]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      price_source: "override",
      input_per_mtok: 0.5,
      output_per_mtok: 2,
    });
  });

  test("keeps overrides for models without a curated name", () => {
    const { models } = modelCatalogView({ prices: [price("in-house-model", 1, 2)] });
    expect(models.find((m) => m.model === "in-house-model")).toMatchObject({
      provider: null,
      display_name: "in-house-model",
      price_source: "override",
    });
  });

  test("a non-USD currency lists no built-in prices", () => {
    const view = modelCatalogView({ currency: "eur", prices: [price("gpt-4.1-mini", 0.3, 1.2)] });
    expect(view.currency).toBe("EUR");
    expect(view.models.map((m) => [m.model, m.price_source])).toEqual([
      ["gpt-4.1-mini", "override"],
    ]);
  });
});
