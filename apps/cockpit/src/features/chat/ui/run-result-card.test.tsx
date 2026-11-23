import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { liveRunExecutionId } from "@/lib/tool-presentation";
import { ChatRunResultView } from "./run-result-card";

function render(locale: Locale, detail: unknown): string {
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
      <ChatRunResultView executionId="run-7" detail={detail} testId="t" />
    </I18nContext.Provider>,
  );
}

const detail = {
  status: "succeeded",
  started_at: "2026-03-02T08:00:00.000Z",
  finished_at: "2026-03-02T08:00:02.000Z",
  outcome: { steps: { succeeded: 1, total: 1 } },
  record_links: [
    {
      label: "ENG-12",
      url: "https://linear.app/acme/issue/ENG-12",
      connector: "linear",
      connector_name: "Linear",
      step_key: "create",
    },
  ],
};

test("a live chat run shows the compact result card with the source system button", () => {
  const de = render("de", detail);
  expect(de).toContain(translate("de", "runs.result.recordsLine.one", { systems: "Linear" }));
  expect(de).toContain("In Linear ansehen");
  expect(de).toContain('href="https://linear.app/acme/issue/ENG-12"');
  expect(render("en", detail)).toContain("View in Linear");
});

test("a chat run without links shows nothing", () => {
  expect(render("de", { ...detail, record_links: [] })).toBe("");
});

test("only a live workflow run hands its execution to the card", () => {
  expect(liveRunExecutionId({ ok: true, data: { execution_id: "run-7" } })).toBe("run-7");
  expect(liveRunExecutionId({ data: { execution_id: "run-7", hold_writes: true } })).toBeNull();
  expect(liveRunExecutionId({ ok: false, error: "permission_denied" })).toBeNull();
});
