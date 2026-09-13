import openapi from "@cli-core/engine-api/openapi.json" with { type: "json" };
import { describe, expect, test } from "bun:test";

import { CATEGORY_ICON, categoryIconFor } from "../domain/connectors/category-icons.ts";

/** The engine's driver list, as published in the generated OpenAPI surface. */
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
    // The catalog block a connector lands in is its driver, so the driver
    // list is the coverage requirement. Read from the committed OpenAPI
    // schema rather than restated here: a hand-written list would have to be
    // remembered the next time a driver is added, and forgetting it costs
    // nothing visible — the new driver just renders as the unknown-category
    // dot forever.
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
    // Object.freeze return value is non-extensible/sealed.
    expect(Object.isFrozen(CATEGORY_ICON)).toBe(true);
  });
});
