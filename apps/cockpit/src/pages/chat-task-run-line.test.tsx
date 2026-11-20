import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskRunLineView } from "@/features/chat/task-run-line";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import type { RunLine } from "./chat-task-run";

const LINE: RunLine = {
  state: { label: "läuft", badge: "running" },
  facts: ["Jetzt: Erinnerungen vorbereiten", "Nächste Prüfung 14:30"],
};

function render(
  props: Partial<Parameters<typeof TaskRunLineView>[0]> = {},
  locale: Locale = "de",
): string {
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
      <TaskRunLineView
        name="Rechnungen nachfassen"
        href="/cockpit/tasks/t1"
        date="19.11."
        line={LINE}
        pending={false}
        unavailable={false}
        onRetry={() => {}}
        onAbort={() => {}}
        {...props}
      />
    </I18nContext.Provider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the run line above a run conversation", () => {
  test("shows task, run date, state, now and next check with the single action", () => {
    const html = render();
    expect(html).toContain('href="/cockpit/tasks/t1"');
    expect(html).toContain("Rechnungen nachfassen");
    expect(html).toContain("Lauf vom 19.11.");
    expect(html).toContain("läuft");
    expect(html).toContain("Jetzt: Erinnerungen vorbereiten");
    expect(html).toContain("Nächste Prüfung 14:30");
    expect(count(html, "<button")).toBe(1);
    expect(html).toContain('data-testid="chat-task-run-abort"');
    expect(html).toContain(">Abbrechen<");
    expect(render({}, "en")).toContain(">Stop<");
    expect(render({ date: "Nov 19" }, "en")).toContain("Run of Nov 19");
  });

  test("an ended run, or a viewer who may not stop it, has no action at all", () => {
    const html = render({ onAbort: null, line: { state: LINE.state, facts: [] } });
    expect(count(html, "<button")).toBe(0);
    expect(html).not.toContain("chat-task-run-abort");
  });

  test("without the right to read tasks the name is a word, not a link", () => {
    const html = render({ href: null });
    expect(html).not.toContain("<a ");
    expect(html).toContain("Rechnungen nachfassen");
  });

  test("while loading there is a placeholder and no stale fact", () => {
    const html = render({ pending: true, line: null, date: null, onAbort: null });
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain("chat-task-run-facts");
    expect(html).not.toContain("Lauf vom");
    expect(count(html, "<button")).toBe(0);
  });

  test("a run that cannot be loaded says so in one sentence and offers one retry", () => {
    const html = render({ unavailable: true, line: null, date: null, onAbort: null });
    expect(html).toContain("Dieser Lauf lässt sich gerade nicht laden.");
    expect(count(html, "<button")).toBe(1);
    expect(html).toContain('data-testid="chat-task-run-retry"');
    expect(render({ unavailable: true, line: null, onAbort: () => {} }, "en")).toContain(
      "This run cannot be loaded right now.",
    );
    expect(render({ unavailable: true, line: null, onAbort: () => {} })).not.toContain(
      "chat-task-run-abort",
    );
  });

  test("an unknown state leaves the badge out and keeps the facts", () => {
    const html = render({ line: { state: null, facts: ["Jetzt: Prüfen"] } });
    expect(html).not.toContain("chat-task-run-state");
    expect(html).toContain("Jetzt: Prüfen");
  });
});
