import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import {
  catalogCategoryGrouping,
  categoryChipOptions,
  compareCategoryKeys,
} from "./catalog-grouping";
import { CatalogNameCell } from "./catalog-metadata";

const i18n: I18nValue = {
  locale: "de",
  preference: "de",
  setPreference() {},
  t: (key, values) => translate("de", key, values),
  tn: (key, count, values) => translatePlural("de", key, count, values),
  dateTime: (date) => String(date),
};

describe("catalog category grouping", () => {
  test("uncategorized entries sort last, the rest alphabetically", () => {
    expect(["other", "notion", "ai"].sort(compareCategoryKeys)).toEqual(["ai", "notion", "other"]);
  });

  test("chips are ordered by usage and humanized", () => {
    const chips = categoryChipOptions(
      [
        { category: "oss-radar", count: 4 },
        { category: "ai", count: 5 },
        { category: "other", count: 5 },
      ],
      "Ohne Kategorie",
    );
    expect(chips.map((chip) => chip.label)).toEqual(["Ai", "Ohne Kategorie", "Oss Radar"]);
  });

  test("headings use server totals and badge only rows that need attention", () => {
    const grouping = catalogCategoryGrouping<{ category: string; failing: boolean }>({
      getCategory: (row) => row.category,
      otherLabel: "Ohne Kategorie",
      counts: new Map([["notion", 11]]),
      needsAttention: (row) => row.failing,
    });
    expect(grouping.label?.("notion")).toBe("Notion");
    expect(grouping.label?.("other")).toBe("Ohne Kategorie");
    expect(grouping.count?.("notion")).toBe(11);
    expect(grouping.collapseScope).toBe("category");
    const badge = renderToStaticMarkup(
      <I18nContext.Provider value={i18n}>
        {grouping.badge?.("notion", [
          { category: "notion", failing: true },
          { category: "notion", failing: false },
        ])}
      </I18nContext.Provider>,
    );
    expect(badge).toContain("1 braucht Aufmerksamkeit");
  });

  test("a grouped row leaves out the category chip it is already filed under", () => {
    const html = (hideCategory: boolean) =>
      renderToStaticMarkup(
        <I18nContext.Provider value={i18n}>
          <CatalogNameCell
            name="notion-search-pages"
            record={{ category: "notion", description: "Sucht Seiten" }}
            hideCategory={hideCategory}
          />
        </I18nContext.Provider>,
      );
    expect(html(false)).toContain('data-slot="chip"');
    expect(html(true)).not.toContain('data-slot="chip"');
    expect(html(true)).toContain("Sucht Seiten");
  });
});
