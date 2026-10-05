import { describe, expect, test } from "bun:test";
import { deriveCategories } from "../../../engine/src/workflows/categorize.ts";
import {
  humanizeCategory,
  memberCountAfterMove,
  recategorizedSlug,
  UNCATEGORIZED,
} from "./workflow-category";

describe("moving a workflow between blocks the engine derived", () => {
  const catalog = [
    "oss-radar-collect",
    "oss-radar-normalize",
    "oss-radar-weekly",
    "company-reporting",
    "company-retention",
    "company-analytics",
  ];
  const categoryOf = (slugs: readonly string[], slug: string) =>
    deriveCategories(slugs).get(slug) ?? UNCATEGORIZED;

  test("each move replaces the block instead of stacking prefixes, and leaving drops it", () => {
    const moved = recategorizedSlug(
      "oss-radar-weekly",
      categoryOf(catalog, "oss-radar-weekly"),
      "company",
    );
    expect(moved).toBe("company-weekly");
    const after = catalog.map((slug) => (slug === "oss-radar-weekly" ? moved : slug));
    expect(recategorizedSlug(moved, categoryOf(after, moved), "oss-radar")).toBe(
      "oss-radar-weekly",
    );
    expect(recategorizedSlug(moved, categoryOf(after, moved), UNCATEGORIZED)).toBe("weekly");
  });
});

describe("recategorized slug", () => {
  test("swaps the current family prefix for the target one", () => {
    expect(recategorizedSlug("radar-collect-weekly", "radar", "mission-control")).toBe(
      "mission-control-collect-weekly",
    );
  });

  test("prefixes a slug that has no family yet", () => {
    expect(recategorizedSlug("ga4-daily-report", "other", "mission-control")).toBe(
      "mission-control-ga4-daily-report",
    );
  });

  test("strips the family when the workflow leaves every block", () => {
    expect(recategorizedSlug("radar-collect-weekly", "radar", "other")).toBe("collect-weekly");
  });

  test("keeps a slug that already heads its target family", () => {
    expect(recategorizedSlug("radar", "radar", "radar")).toBe("radar");
    expect(recategorizedSlug("radar-collect", "radar", "radar")).toBe("radar-collect");
  });

  test("does not treat the catch-all name as a prefix to strip", () => {
    expect(recategorizedSlug("other-thing", "other", "radar")).toBe("radar-other-thing");
  });
});

describe("member count after a move", () => {
  const counts = new Map([
    ["radar", 6],
    ["mission-control", 2],
  ]);

  test("counts the arriving workflow into the target family", () => {
    expect(memberCountAfterMove(counts, "radar", "mission-control")).toBe(3);
  });

  test("does not double-count a workflow that stays put", () => {
    expect(memberCountAfterMove(counts, "radar", "radar")).toBe(6);
  });

  test("treats an unknown target as its first member", () => {
    expect(memberCountAfterMove(counts, "radar", "fresh")).toBe(1);
  });
});

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
