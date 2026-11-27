import { describe, expect, test } from "bun:test";
import { render } from "@/features/settings/model/settings-fixtures";
import { translate } from "@/lib/i18n";
import { groupByKind, type VaultItem } from "./model/vault";
import { VaultList } from "./page";
import { CvvInput, PaymentFacts } from "./payments";
import { ValueFields } from "./value-fields";

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

const PAYMENT = {
  id: "6f1c2b9e-4a7d-4c1e-9b3a-2d5e8f7a1c04",
  status: "pending" as const,
  origin: "https://shop.example.com",
  host: "shop.example.com",
  amountMinor: 1234,
  currency: "EUR",
  expiresAt: "2026-11-27T10:14:32Z",
  brand: "visa",
  last4: "4242",
  cardName: null,
};

describe("payment approval panel", () => {
  test("shows shop, amount, card and countdown", () => {
    const now = Date.parse("2026-11-27T10:00:00Z");
    const en = render(<PaymentFacts payment={PAYMENT} now={now} />, "en");
    expect(en).toContain("shop.example.com");
    expect(en).toContain("€12.34");
    expect(en).toContain("Visa •••• 4242");
    expect(en).toContain(translate("en", "vault.payment.expiresIn", { time: "14:32" }));
    const de = render(<PaymentFacts payment={PAYMENT} now={now} />, "de");
    expect(de).not.toContain("€12.34");
  });

  test("the CVV input is numeric, not autocompleted, length-limited and described", () => {
    const html = render(
      <CvvInput value="" brand="visa" error="x" disabled={false} onChange={() => {}} />,
      "en",
    );
    const input = tag(html, "vault-payment-cvv");
    expect(input).toContain('inputMode="numeric"');
    expect(input).toContain('type="text"');
    expect(input).toContain("[-webkit-text-security:disc]");
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('maxLength="3"');
    expect(input).toContain('aria-describedby="vault-payment-cvv-help vault-payment-cvv-error"');
    expect(input).toContain('aria-invalid="true"');
    const amex = render(
      <CvvInput value="" brand="amex" error={null} disabled={false} onChange={() => {}} />,
      "en",
    );
    expect(tag(amex, "vault-payment-cvv")).toContain('maxLength="4"');
  });
});

describe("entry forms", () => {
  test("the card form has no CVV field, explains why and names the detected brand", () => {
    const draft = {
      kind: "card" as const,
      token: "",
      username: "",
      password: "",
      fields: { number: "4242 42" },
    };
    const html = render(
      <ValueFields idPrefix="vault-add" draft={draft} onChange={() => {}} error={null} />,
      "en",
    );
    expect(html).not.toMatch(/data-testid="vault-add-cvv"/);
    expect(html).toContain(translate("en", "vault.card.noCvv"));
    expect(html).toContain("Detected: Visa");
    expect(tag(html, "vault-add-number")).toContain('inputMode="numeric"');
    expect(tag(html, "vault-add-number")).toContain("vault-add-no-cvv");
  });

  test("field problems are linked to their input", () => {
    const draft = {
      kind: "bank_account" as const,
      token: "",
      username: "",
      password: "",
      fields: {},
    };
    const html = render(
      <ValueFields
        idPrefix="vault-add"
        draft={draft}
        onChange={() => {}}
        error={null}
        fieldErrors={{ iban: { key: "vault.bank.ibanInvalid" } }}
      />,
      "en",
    );
    expect(tag(html, "vault-add-iban")).toContain('aria-describedby="vault-add-iban-error"');
    expect(html).toContain(translate("en", "vault.bank.ibanInvalid"));
    expect(html).toContain(translate("en", "vault.field.optional", { label: "BIC" }));
  });

  test("the list shows only masked card metadata", () => {
    const card: VaultItem = {
      id: "00000000-0000-4000-8000-000000000009",
      name: "visa",
      kind: "card",
      scope: "person",
      environment: "prod",
      description: null,
      version: 1,
      connector: null,
      template_slug: null,
      fields: [],
      metadata: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 },
      origins: [],
      created_at: "2026-11-01T08:00:00.000Z",
      updated_at: "2026-11-01T08:00:00.000Z",
      rotated_at: null,
      last_used_at: null,
    };
    const html = render(<VaultList groups={groupByKind([card])} onOpen={() => {}} />, "en");
    expect(html).toContain("Visa •••• 4242 · expires 12/28");
    expect(html).toContain('data-testid="vault-group-card"');
  });
});
