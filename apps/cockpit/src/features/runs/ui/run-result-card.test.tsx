import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { RunRecordsCard } from "./run-result-card";

const detail = {
  status: "succeeded",
  outcome: { steps: { succeeded: 3, total: 3 } },
  record_links: [
    {
      label: "acme/app#42",
      url: "https://github.com/acme/app/issues/42",
      connector: "github",
      connector_name: "GitHub",
      step_key: "create_issue",
    },
    {
      label: null,
      url: "https://www.notion.so/Plan-0123",
      connector: "notion",
      connector_name: "Notion",
      step_key: "write_page",
    },
  ],
};

function render(locale: Locale, value: unknown = detail): string {
  const i18n = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={i18n}>
      <RunRecordsCard detail={value} title="Erfolgreich" duration="1,2 s" testId="card" />
    </I18nContext.Provider>,
  );
}

test("the German card shows the outcome, key values, details and the source system buttons", () => {
  const html = render("de");
  expect(html).toContain("Erfolgreich");
  expect(html).toContain(
    translate("de", "runs.result.recordsLine.other", { count: 2, systems: "GitHub, Notion" }),
  );
  expect(html).toContain("3 von 3 erledigt");
  expect(html).toContain("1,2 s");
  expect(html).toContain("In GitHub ansehen");
  expect(html).toContain("In Notion ansehen");
  expect(html).toContain("Details anzeigen");
});

test("the English card offers the same in English", () => {
  const html = render("en");
  expect(html).toContain("Changed 2 records in GitHub, Notion.");
  expect(html).toContain("View in GitHub");
  expect(html).toContain("Show details");
});

test("external links open in a new tab without access to the Cockpit window", () => {
  const html = render("en");
  expect(html).toContain('href="https://github.com/acme/app/issues/42"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("opens in a new tab");
});

test("a run without record links shows no card", () => {
  expect(render("de", { ...detail, record_links: [] })).toBe("");
});
