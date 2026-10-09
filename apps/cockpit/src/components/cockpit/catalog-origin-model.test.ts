import { expect, test } from "bun:test";
import { catalogAICount } from "./catalog-origin-model";

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
