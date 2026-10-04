import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import type { ChatText } from "./chat-text";
import { ChatTextCard } from "./chat-text-card";

function render(text: ChatText, locale: Locale = "de"): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <ChatTextCard text={text} busy={false} error={false} onAnswer={() => {}} testId="text" />
    </I18nContext.Provider>,
  );
}

const question: ChatText = {
  id: "request",
  toolCallId: "call",
  question: "Wie soll dein Workflow heißen?",
  placeholder: "Example API Data Fetch",
  multiline: false,
  expiresAt: "2099-01-01T00:00:00Z",
};

function element(html: string, tag: string, testId: string): string {
  return html.match(new RegExp(`<${tag}[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
}

test("the question, its placeholder and an answer action are on screen", () => {
  const html = render(question);
  expect(html).toContain("Wie soll dein Workflow heißen?");
  expect(element(html, "input", "text-input")).toContain('placeholder="Example API Data Fetch"');
  expect(html).toMatch(/data-testid="text-submit"[^>]*>(?:<[^>]+>)*Antworten</);
  expect(element(html, "button", "text-submit")).toMatch(/ disabled=""/);
});

test("a default is offered as the answer to confirm or edit", () => {
  const html = render({ ...question, initialValue: "Tagesbericht" }, "en");
  expect(element(html, "input", "text-input")).toContain('value="Tagesbericht"');
  expect(element(html, "button", "text-submit")).not.toMatch(/ disabled=""/);
  expect(html).toContain(">Answer<");
});

test("a multiline question takes a text area; one without a placeholder gets a neutral one", () => {
  const html = render({ ...question, multiline: true, placeholder: undefined });
  expect(element(html, "textarea", "text-input")).toContain('placeholder="Antwort eingeben …"');
});

test("an expired question cannot be answered", () => {
  const html = render({ ...question, initialValue: "x", expiresAt: "2000-01-01T00:00:00Z" });
  expect(element(html, "button", "text-submit")).toMatch(/ disabled=""/);
  expect(element(html, "input", "text-input")).toMatch(/ disabled=""/);
});
