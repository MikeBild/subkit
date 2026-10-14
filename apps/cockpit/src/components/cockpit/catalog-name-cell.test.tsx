import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { CatalogNameCell } from "./catalog-metadata";

function render(locale: "de" | "en", description: unknown) {
  const value: I18nValue = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  };
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <CatalogNameCell name="Example" record={{ description }} />
    </I18nContext.Provider>,
  );
}

describe("catalog name cell description", () => {
  test("shows the exact localized empty-description copy for absent and blank values", () => {
    const emptyDescriptions = [undefined, null, "", "   "];
    const placeholders = {
      de: "Noch keine Beschreibung – die KI ergänzt sie in Kürze.",
      en: "No description yet — the assistant adds one shortly.",
    };

    for (const locale of ["de", "en"] as const) {
      for (const description of emptyDescriptions) {
        const html = render(locale, description);
        expect(html).toContain(placeholders[locale]);
        expect(html).not.toContain("undefined");
        expect(html).not.toContain("null");
      }
    }
  });

  test("shows a non-empty description instead of the placeholder", () => {
    for (const locale of ["de", "en"] as const) {
      const description = "Readable record description";
      const html = render(locale, description);
      expect(html).toContain(description);
      expect(html).not.toContain(translate(locale, "catalogMeta.empty"));
    }
  });
});
