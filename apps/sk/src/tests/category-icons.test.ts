import { describe, expect, test } from "bun:test";
import openapi from "@cli-core/engine-api/openapi.json" with { type: "json" };
import { CATEGORY_ICON, categoryIconFor } from "../domain/connectors/category-icons.ts";

const DRIVER_ENUM: string[] =
  (
    openapi as {
      components: {
        schemas: Record<string, { properties?: { driver?: { enum?: string[] } } }>;
      };
    }
  ).components.schemas.CreateConnectorBody?.properties?.driver?.enum ?? [];

describe("category-icons", () => {
  test("returns the category-specific glyph when the key is known", () => {
    expect(categoryIconFor("http")).toBe(String(CATEGORY_ICON.http));
    expect(categoryIconFor("postgres")).toBe(String(CATEGORY_ICON.postgres));
  });

  test("falls back to the default glyph for unknown categories", () => {
    expect(categoryIconFor("unknown-driver")).toBe(String(CATEGORY_ICON.default));
  });

  test("every driver the engine ships has a glyph of its own", () => {
    const drivers = DRIVER_ENUM;
    expect(drivers.length).toBeGreaterThan(1);
    const missing = drivers.filter((d) => categoryIconFor(d) === String(CATEGORY_ICON.default));
    expect(missing).toEqual([]);
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
    expect(Object.isFrozen(CATEGORY_ICON)).toBe(true);
  });
});
