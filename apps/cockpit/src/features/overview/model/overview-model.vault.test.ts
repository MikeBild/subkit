import { describe, expect, test } from "bun:test";
import { needVisual } from "@/features/operations/model/operations";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  attentionDetail,
  attentionRow,
  attentionSentence,
  sentenceText,
  vaultAttentionFacts,
} from "./overview-model";
import { item, NOW } from "./overview-model-fixtures.ts";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);
const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "33333333-3333-4333-8333-333333333333";

const payment = item({
  id: `vault_payment:${PAYMENT}`,
  class: "decide",
  severity: "urgent",
  kind: "vault_payment_pending",
  subject: { kind: "conversation", id: CONVERSATION, name: "https://shop.example.com" },
  reason: "payment_approval_needed",
  detail: null,
  vault: {
    kind: "payment",
    id: PAYMENT,
    origin: "https://shop.example.com",
    conversation_id: CONVERSATION,
    amount_minor: 1234,
    currency: "EUR",
    card: { brand: "visa", last4: "4242" },
  },
  actions: [
    {
      verb: "review",
      href: `/cockpit/chat/${CONVERSATION}?payment=${PAYMENT}`,
      primary: true,
      permission: "conversation:write",
    },
  ],
});

const signIn = item({
  ...payment,
  id: "vault_sign_in:call_1",
  kind: "vault_sign_in_pending",
  reason: "sign_in_confirmation_needed",
  vault: {
    kind: "sign_in",
    id: "call_1",
    origin: "https://www.example.org",
    conversation_id: CONVERSATION,
  },
});

describe("vault attention items", () => {
  test("a payment reads as a sentence with shop, amount and masked card as facts", () => {
    expect(sentenceText(attentionSentence(payment, en, NOW))).toContain(
      "A payment with one of your cards waits for your approval with the CVV",
    );
    expect(vaultAttentionFacts(payment, "en")).toBe("shop.example.com · €12.34 · Visa •••• 4242");
    expect(vaultAttentionFacts(payment, "de")).toContain("12,34");
    expect(attentionDetail(payment, en)).toBeNull();
  });

  test("amounts follow the currency's minor units", () => {
    const yen = { vault: { ...payment.vault!, amount_minor: 1500, currency: "jpy" } };
    expect(vaultAttentionFacts(yen, "en")).toContain("¥1,500");
    const dinar = { vault: { ...payment.vault!, amount_minor: 1500, currency: "KWD" } };
    expect(vaultAttentionFacts(dinar, "en")).toContain("1.500");
  });

  test("a sign-in names the site and has its own short label in both languages", () => {
    expect(vaultAttentionFacts(signIn, "en")).toBe("www.example.org");
    expect(sentenceText(attentionSentence(signIn, en, NOW))).toContain(
      "A sign-in with your vault waits for your confirmation",
    );
    expect(attentionRow(signIn, en).reason).toBe("Confirm sign-in");
    expect(attentionRow(signIn, de).reason).toBe(
      translate("de", "overview.short.sign_in_confirmation_needed"),
    );
    expect(needVisual(signIn.reason).icon).toBe("approval");
  });

  test("items without vault facts render no facts line", () => {
    expect(vaultAttentionFacts({ vault: undefined }, "en")).toBeNull();
  });
});
