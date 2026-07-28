// Unit tests for the derived catalog categories. Pure functions — no DB.

import { describe, expect, test } from "bun:test";
import {
  deriveCategories,
  groupByCategory,
  MIN_CATEGORY_SIZE,
  UNCATEGORIZED,
} from "./categorize.ts";

/**
 * A slice of the real tenant catalog — the corpus that motivated the feature.
 * Kept verbatim so the regression it guards (a dozen single-item blocks) stays
 * pinned to the names that actually produced it.
 */
const REAL_SLUGS = [
  "mission-control-content-analysis-weekly",
  "mission-control-growth-weekly",
  "mission-control-infrastructure-daily",
  "mission-control-reporting-rollup-daily",
  "mission-control-reporting-rollup-monthly",
  "mission-control-reporting-rollup-weekly",
  "mission-control-reporting-rollup-yearly",
  "notion-append-markdown",
  "notion-database-inspect",
  "notion-datasource-create-page",
  "notion-essay-to-markdown",
  "notion-page-properties-patch",
  "notion-page-to-markdown",
  "notion-search-pages",
  "contentkit-contact-notify",
  "contentkit-projects-sync",
  "contentkit-publish-deck",
  "contentkit-publish-page",
  "company-product-analytics-hourly",
  "company-report-publish-contentkit",
  "company-reporting-retention",
  "berlin-weather-by-date",
  "berlin-weather-tomorrow",
  "capture-dogfood-observation",
  "dogfooding-daily-review",
  "promote-dogfood-learning",
  "corsica-ferries-prices",
  "droplet-daily-digest",
  "ga4-daily-report",
  "web-article-to-summary",
  "public-github-repositories",
];

describe("deriveCategories", () => {
  test("groups the real catalog into a handful of families, not a block per workflow", () => {
    const categories = deriveCategories(REAL_SLUGS);
    const blocks = groupByCategory(REAL_SLUGS, (s) => categories.get(s) ?? UNCATEGORIZED);

    expect(blocks.map((b) => [b.category, b.items.length])).toEqual([
      ["mission-control", 7],
      ["notion", 7],
      ["contentkit", 4],
      ["company", 3],
      [UNCATEGORIZED, 10],
    ]);
  });

  test("keeps the meaningful family name over an equally-large fragment", () => {
    // `mission` and `mission-control` both match all 7 — the longer, meaningful
    // one must win. This is the tie-break that makes the whole rule readable.
    const categories = deriveCategories(REAL_SLUGS);
    expect(categories.get("mission-control-growth-weekly")).toBe("mission-control");
  });

  test("does not split a family into a narrower sub-block", () => {
    // `mission-control-reporting-rollup` matches 4 — real, but narrower than the
    // 7-member family. The wider family wins so the catalog stays few blocks.
    const categories = deriveCategories(REAL_SLUGS);
    expect(categories.get("mission-control-reporting-rollup-daily")).toBe("mission-control");
  });

  test("sends a prefix below the threshold to the catch-all", () => {
    // Only two `berlin-weather-*` exist, so they must not form a block of two.
    const categories = deriveCategories(REAL_SLUGS);
    expect(categories.get("berlin-weather-by-date")).toBe(UNCATEGORIZED);
    expect(categories.get("berlin-weather-tomorrow")).toBe(UNCATEGORIZED);
  });

  test("does not invent a block for one-off workflows", () => {
    const categories = deriveCategories(REAL_SLUGS);
    for (const slug of [
      "corsica-ferries-prices",
      "droplet-daily-digest",
      "ga4-daily-report",
      "web-article-to-summary",
      "public-github-repositories",
    ]) {
      expect(categories.get(slug)).toBe(UNCATEGORIZED);
    }
  });

  test("misses a shared concept that is not a shared prefix", () => {
    // Documents a real limit rather than pretending it away: the three
    // dogfood workflows carry the concept mid-slug, so prefix derivation
    // cannot see them. Renaming them is the (user-driven) fix.
    const categories = deriveCategories(REAL_SLUGS);
    expect(categories.get("capture-dogfood-observation")).toBe(UNCATEGORIZED);
    expect(categories.get("dogfooding-daily-review")).toBe(UNCATEGORIZED);
    expect(categories.get("promote-dogfood-learning")).toBe(UNCATEGORIZED);
  });

  test("honours the threshold exactly", () => {
    const two = ["alpha-one", "alpha-two"];
    expect([...deriveCategories(two).values()]).toEqual([UNCATEGORIZED, UNCATEGORIZED]);

    const three = ["alpha-one", "alpha-two", "alpha-three"];
    expect([...deriveCategories(three).values()]).toEqual(["alpha", "alpha", "alpha"]);
    expect(three.length).toBe(MIN_CATEGORY_SIZE);
  });

  test("lets a slug head its own family", () => {
    const slugs = ["notion", "notion-search", "notion-append"];
    expect(deriveCategories(slugs).get("notion")).toBe("notion");
  });

  test("splits only on dash boundaries, never mid-word", () => {
    // `report` must not be pulled out of `reporting`.
    const slugs = ["reporting-a", "reporting-b", "reporting-c"];
    expect(deriveCategories(slugs).get("reporting-a")).toBe("reporting");
  });

  test("is deterministic and order-independent", () => {
    const forward = deriveCategories(REAL_SLUGS);
    const reversed = deriveCategories([...REAL_SLUGS].reverse());
    for (const slug of REAL_SLUGS) {
      expect(reversed.get(slug)).toBe(forward.get(slug) as string);
    }
  });

  test("handles an empty catalog", () => {
    expect(deriveCategories([]).size).toBe(0);
    expect(groupByCategory([], () => UNCATEGORIZED)).toEqual([]);
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
