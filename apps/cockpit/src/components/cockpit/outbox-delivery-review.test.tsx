import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OutboxDeliveryReview } from "@/components/cockpit/grant-workflow-authority";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";

function render(
  locale: Locale,
  deliveries: Parameters<typeof OutboxDeliveryReview>[0]["deliveries"],
) {
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
      <OutboxDeliveryReview deliveries={deliveries} />
    </I18nContext.Provider>,
  );
}

const delivery = {
  kind: "gmail_outbox" as const,
  source_step_id: "next_mail",
  recipient_field: "recipient",
  item_id_field: "id",
  from: "workshops@example.test",
  content_type: "text/plain" as const,
  max_body_bytes: 4096,
  max_per_day: 50,
};

test("the approval names the queue that chooses recipients and its daily limit", () => {
  const html = render("de", [delivery]);
  expect(html).toContain("Nachrichten aus einer Warteschlange");
  expect(html).toContain("Wer die Warteschlange füllen kann, bestimmt die Empfänger");
  expect(html).toContain("Schritt next_mail");
  expect(html).toContain("50 Nachrichten pro Tag");
  expect(render("en", [delivery])).toContain("Messages from a queue");
  expect(render("en", [])).toBe("");
});
