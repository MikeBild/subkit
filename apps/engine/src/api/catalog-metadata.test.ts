import { describe, expect, test } from "bun:test";
import {
  CatalogMetadataPatchSchema,
  CategorySchema,
  groupByCategory,
  humanMetadataWrite,
  metadataChange,
  normalizeCategory,
  UNCATEGORIZED,
} from "./catalog-metadata.ts";

describe("normalizeCategory", () => {
  test("folds free text into the shared category shape", () => {
    expect(normalizeCategory("Billing Reports")).toBe("billing-reports");
    expect(normalizeCategory("  Über_Wachung!! ")).toBe("uber-wachung");
    expect(normalizeCategory("a--b")).toBe("a-b");
  });

  test("never returns a value the database check would refuse", () => {
    expect(normalizeCategory("!!!")).toBeNull();
    const long = normalizeCategory(`${"word-".repeat(20)}end`);
    expect(long).not.toBeNull();
    expect(long?.length).toBeLessThanOrEqual(40);
    expect(long?.endsWith("-")).toBe(false);
  });
});

describe("CategorySchema", () => {
  test("accepts the shared shape and refuses anything else", () => {
    expect(CategorySchema.safeParse("mission-reports").success).toBe(true);
    expect(CategorySchema.safeParse("Mission Reports").success).toBe(false);
    expect(CategorySchema.safeParse("x".repeat(41)).success).toBe(false);
  });
});

describe("humanMetadataWrite", () => {
  test("a person's text never stores a secret", () => {
    const token = ["ghp", "_", "C".repeat(36)].join("");
    const write = humanMetadataWrite({ description: `Reads repos with ${token}.` });
    expect(write.description).not.toContain(token);
    expect(write.description_source).toBe("human");
  });

  test("a person's text owns the field", () => {
    expect(
      humanMetadataWrite({ description: " Sends the weekly report. ", category: "reports" }),
    ).toEqual({
      description: "Sends the weekly report.",
      description_source: "human",
      category: "reports",
      category_source: "human",
    });
  });

  test("clearing a field hands it back to automatic description", () => {
    expect(humanMetadataWrite({ description: "", category: null })).toEqual({
      description: null,
      description_source: "llm",
      category: UNCATEGORIZED,
      category_source: "llm",
      catalog_input_hash: null,
      catalog_described_at: null,
    });
  });

  test("an absent field is left alone", () => {
    expect(humanMetadataWrite({})).toEqual({});
  });
});

describe("groupByCategory", () => {
  test("orders biggest family first and always parks the catch-all last", () => {
    const items = [
      { slug: "x", category: UNCATEGORIZED },
      { slug: "a1", category: "alpha" },
      { slug: "b1", category: "beta" },
      { slug: "b2", category: "beta" },
    ];
    expect(groupByCategory(items, (i) => i.category).map((b) => b.category)).toEqual([
      "beta",
      "alpha",
      UNCATEGORIZED,
    ]);
  });

  test("breaks equal-sized ties by name, locale-independently", () => {
    const items = [
      { category: "zulu" },
      { category: "alpha" },
      { category: "zulu" },
      { category: "alpha" },
    ];
    expect(groupByCategory(items, (i) => i.category).map((b) => b.category)).toEqual([
      "alpha",
      "zulu",
    ]);
  });
});

describe("explicit description acceptance", () => {
  const current = { description: "Approved text", description_source: "llm", category: "other" };
  test("unchanged text keeps generated provenance until explicitly accepted", () => {
    expect(metadataChange(current, { description: current.description })).toBeNull();
    expect(
      metadataChange(current, { description: current.description, accept_description: true }),
    ).toEqual({ description: current.description, description_source: "human" });
    expect(
      metadataChange(
        { ...current, description_source: "human" },
        { description: current.description, accept_description: true },
      ),
    ).toBeNull();
  });
  test("acceptance never replaces changed text and rejects missing or empty text", () => {
    expect(() =>
      metadataChange(current, { description: "Older text", accept_description: true }),
    ).toThrow("description changed");
    for (const description of [undefined, null, "", "   "]) {
      const patch = {
        ...(description !== undefined ? { description } : {}),
        accept_description: true,
      };
      expect(CatalogMetadataPatchSchema.safeParse(patch).success).toBe(false);
      expect(() => metadataChange(current, patch)).toThrow("exact nonempty text");
    }
    expect(metadataChange(current, { description: null })).toMatchObject({
      description: null,
      description_source: "llm",
    });
  });
});
