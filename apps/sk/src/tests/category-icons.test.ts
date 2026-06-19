import { describe, expect, test } from "bun:test";
import { CATEGORY_ICON, categoryIconFor } from "../domain/connectors/category-icons.ts";

describe("category-icons", () => {
  test("returns the category-specific glyph when the key is known", () => {
    expect(categoryIconFor("http")).toBe(String(CATEGORY_ICON.http));
    expect(categoryIconFor("postgres")).toBe(String(CATEGORY_ICON.postgres));
  });

  test("falls back to the default glyph for unknown categories", () => {
    expect(categoryIconFor("unknown-driver")).toBe(String(CATEGORY_ICON.default));
  });

  test("treats null/undefined as default", () => {
    expect(categoryIconFor(null)).toBe(String(CATEGORY_ICON.default));
    expect(categoryIconFor(undefined)).toBe(String(CATEGORY_ICON.default));
  });

  test("category lookup is case-insensitive", () => {
    expect(categoryIconFor("HTTP")).toBe(String(CATEGORY_ICON.http));
    expect(categoryIconFor("PostgreS")).toBe(String(CATEGORY_ICON.postgres));
  });

  test("CATEGORY_ICON is a frozen map", () => {
    // Object.freeze return value is non-extensible/sealed.
    expect(Object.isFrozen(CATEGORY_ICON)).toBe(true);
  });
});
