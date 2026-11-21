import { describe, expect, test } from "bun:test";
import { humanizeCategory } from "@/features/workflows/model/workflow-category";

describe("humanizeCategory", () => {
  const cases: Array<[string, string]> = [
    ["mission-control", "Mission Control"],
    ["radar", "Radar"],
    ["mikebild-dev", "Mikebild Dev"],
    ["company_reporting", "Company Reporting"],
    ["other", "Ohne Block"],
    ["", "Ohne Block"],
  ];
  for (const [slug, expected] of cases)
    test(`${JSON.stringify(slug)} reads "${expected}"`, () => {
      expect(humanizeCategory(slug, "Ohne Block")).toBe(expected);
    });

  test("never prints a hyphenated slug", () => {
    for (const [slug] of cases) expect(humanizeCategory(slug, "Ohne Block")).not.toContain("-");
  });
});
