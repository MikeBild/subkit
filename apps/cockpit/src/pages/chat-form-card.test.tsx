import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import type { ChatForm } from "./chat-form";
import { ChatFormCard } from "./chat-form-card";

function render(form: ChatForm, locale: Locale = "de"): string {
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
      <ChatFormCard form={form} busy={false} error={false} onAnswer={() => {}} testId="form" />
    </I18nContext.Provider>,
  );
}

const credential: ChatForm = {
  id: "credential",
  toolCallId: "ask",
  question: "Enter the Metabase API key",
  expiresAt: "2030-01-01T00:00:00Z",
  intentKind: "save_connector_draft",
  fields: [
    { name: "token", label: "API key", type: "password", sensitive: true, required: true },
    { name: "host", label: "Host", type: "text" },
  ],
};

function input(html: string, testId: string): string {
  return html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
}

test("a password field renders as a masked input with a truthful hint", () => {
  const html = render(credential);
  const secret = input(html, "form-field-0");
  expect(secret).toContain('type="password"');
  expect(secret).toContain('autoComplete="new-password"');
  expect(secret).toContain('value=""');
  expect(html).toContain("Wird verschlüsselt beim Connector gespeichert, nie im Chat angezeigt.");
  expect(input(html, "form-field-1")).toContain('type="text"');
  expect(html).not.toContain('data-testid="form-field-1-hint"');
});

test("without a connector save the hint claims no storage at all", () => {
  const html = render({ ...credential, intentKind: undefined }, "en");
  expect(html).toContain("Never stored or shown in the chat.");
  expect(html).not.toContain("encrypted");
});

test("a sensitive text field is masked too and never shows a default", () => {
  const html = render({
    ...credential,
    fields: [
      { name: "api_key", label: "Key", type: "text", sensitive: true, default: "leaked-default" },
    ],
  });
  expect(input(html, "form-field-0")).toContain('type="password"');
  expect(html).not.toContain("leaked-default");
});
