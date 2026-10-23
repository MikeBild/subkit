import { expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  CATALOG_CREATED_BY_PARAM,
  catalogAICount,
  createdByDescriptionSource,
  isCatalogCreatedBy,
} from "./catalog-origin-model";

test("AI totals use the complete category aggregate for the requested resource", () => {
  expect(
    catalogAICount(
      [
        { llm_counts: { workflow: 120, connector: 3 } },
        { llm_counts: { workflow: 81, connector: 2 } },
      ],
      "workflow",
    ),
  ).toBe(201);
  expect(catalogAICount([{ llm_counts: { workflow: 0 } }], "workflow")).toBe(0);
  expect(catalogAICount([], "workflow")).toBe(0);
});

test("unavailable or partial provenance totals remain unknown", () => {
  expect(catalogAICount(undefined, "workflow")).toBeNull();
  expect(catalogAICount([{ llm_counts: { workflow: 3 } }, {}], "workflow")).toBeNull();
  expect(catalogAICount([{ llm_counts: { connector: 3 } }], "workflow")).toBeNull();
});

test("the created-by filter maps AI and Person onto the description source and keeps all otherwise", () => {
  expect(createdByDescriptionSource("ai")).toBe("llm");
  expect(createdByDescriptionSource("person")).toBe("human");
  expect(createdByDescriptionSource("all")).toBeUndefined();
  expect(["all", "ai", "person", "llm", ""].map(isCatalogCreatedBy)).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
  expect(CATALOG_CREATED_BY_PARAM).toBe("created_by");
});

test("the described-by filter speaks the glossary in both languages", () => {
  expect(
    ["catalog.createdBy", "catalog.createdBy.ai", "catalog.createdBy.person"].map((key) =>
      translate("de", key as Parameters<typeof translate>[1]),
    ),
  ).toEqual(["Beschrieben von", "KI", "Person"]);
  expect(
    ["catalog.createdBy", "catalog.createdBy.ai", "catalog.createdBy.person"].map((key) =>
      translate("en", key as Parameters<typeof translate>[1]),
    ),
  ).toEqual(["Described by", "AI", "Person"]);
  expect(translate("de", "catalog.createdByChip", { who: "KI" })).toBe("Beschrieben von: KI");
});
