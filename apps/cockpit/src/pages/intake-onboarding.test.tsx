import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { IntakeOnboarding } from "./intake";

const value = {
  locale: "de",
  preference: "de",
  setPreference() {},
  t: (key, values) => translate("de", key, values),
  tn: (key, count, values) => translatePlural("de", key, count, values),
  dateTime: (date) => String(date),
} as I18nValue;

function render(onAddNote?: () => void) {
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <IntakeOnboarding {...(onAddNote ? { onAddNote } : {})} />
    </I18nContext.Provider>,
  );
}

describe("intake onboarding", () => {
  test("writers get a third way to collect: a note without an address", () => {
    const html = render(() => {});
    expect(html).toContain("Als Notiz");
    expect(html).toContain("Schreib einen Gedanken oder füg eine Adresse ein.");
    expect(html).toContain('data-testid="intake-onboarding-note"');
    expect(html).toContain("Notiz hinzufügen");
    expect(html).toContain("sm:grid-cols-3");
  });

  test("readers see only the ways they can follow", () => {
    const html = render();
    expect(html).not.toContain("intake-onboarding-note");
    expect(html).toContain("sm:grid-cols-2");
  });
});
