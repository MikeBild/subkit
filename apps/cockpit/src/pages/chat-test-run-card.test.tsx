import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import type { ChatWorkflowRef } from "./chat-preview-cards";
import type { ChatSensitiveTestRun } from "./chat-test-run";
import { ChatTestRunCard } from "./chat-test-run-card";

function render(
  run: ChatSensitiveTestRun,
  locale: Locale,
  saved: ChatWorkflowRef | null = null,
  latest = true,
): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <ChatTestRunCard run={run} saved={saved} latest={latest} testId="t" />
    </I18nContext.Provider>,
  );
}

const run: ChatSensitiveTestRun = {
  succeeded: true,
  steps: { succeeded: 2, failed: 0, held: 1 },
  reads: [{ step: "read", items: 120, complete: false }],
  checks: "passed",
  executionId: null,
};

test("the German card shows status, step counts, reads and the check without contents", () => {
  const html = render(run, "de");
  expect(html).toContain("Probelauf erfolgreich");
  expect(html).toContain("Inhalte bleiben verborgen");
  expect(html).toContain("2 ok · 0 fehlgeschlagen · 1 zurückgehalten");
  expect(html).toContain("120 Einträge, abgeschnitten");
  expect(html).toContain("bestanden");
});

test("a failed run without checks names the failure and omits the check", () => {
  const html = render(
    { ...run, succeeded: false, steps: { succeeded: 1, failed: 1, held: 0 }, checks: "none" },
    "en",
  );
  expect(html).toContain("Trial run failed");
  expect(html).toContain("1 ok · 1 failed · 0 held back");
  expect(html).not.toContain("chat-test-run-checks");
});

const savedRef: ChatWorkflowRef = { id: "wf-1", label: "upraft-auth-notify" };

test("a saved successful test run offers the Cockpit check in German and English", () => {
  const de = render(run, "de", savedRef);
  expect(de).toContain('href="/cockpit/workflows/wf-1#workflow-run"');
  expect(de).toContain("Im Cockpit selbst prüfen");
  expect(de).toContain("@upraft-auth-notify");
  expect(de).toContain("w-full");
  expect(de).toContain("sm:w-auto");
  expect(render(run, "en", savedRef)).toContain("Check it yourself in the Cockpit");
});

test("the Cockpit check opens this test run, and an older card offers it no more", () => {
  expect(render({ ...run, executionId: "run-7" }, "de", savedRef)).toContain(
    'href="/cockpit?run=run-7"',
  );
  expect(render(run, "de", savedRef, false)).not.toContain("t-verify");
});

test("an unsaved or failed test run offers no Cockpit check", () => {
  expect(render(run, "en")).not.toContain("t-verify");
  expect(render({ ...run, succeeded: false }, "en", savedRef)).not.toContain("t-verify");
});
