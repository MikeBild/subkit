// A setting's description is the engine's English wording. On the German
// screen it read as the Cockpit's own sentence in the wrong language; it is
// now marked as the engine's words, in `lang="en"`, and never translated.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { EngineWording } from "@/lib/machine-label";

function render(locale: Locale): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <EngineWording text="Monthly token budget for the tenant" />
    </I18nContext.Provider>,
  );
}

describe("the engine's wording", () => {
  test("on a German screen it says whose words these are, and that they are English", () => {
    const html = render("de");
    expect(html).toContain("Wortlaut der Engine");
    expect(html).toContain('<span lang="en">Monthly token budget for the tenant</span>');
  });

  test("on an English screen the words stand as they are, still marked as English", () => {
    const html = render("en");
    expect(html).not.toContain(translate("en", "common.engineWordingLabel"));
    expect(html).toContain('<span lang="en">Monthly token budget for the tenant</span>');
  });

  test("the settings page renders a description only through it", () => {
    // A bare `{item.meta.description}` child is the English sentence posing as
    // the Cockpit's own.
    const source = readFileSync(resolve(import.meta.dir, "../pages/settings.tsx"), "utf8");
    expect(source).not.toMatch(/^\s*\{item\.meta\.description\}\s*$/m);
    expect(source).toContain("<EngineWording");
  });
});
