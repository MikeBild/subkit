import { describe, expect, test } from "bun:test";
import type { ApprovalRule } from "@/api/approval-rules";
import { render } from "@/components/cockpit/patterns/test-utils";
import { type TranslationKey, translate } from "@/lib/i18n";
import { RuleRow } from "./settings-rules";
import {
  contentClassLine,
  namedConnector,
  ruleFacts,
  ruleValidity,
  todayLine,
  validityLine,
} from "./settings-rules-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);
const date = (value: string) => value.slice(0, 10);

const rule: ApprovalRule = {
  id: "r1",
  state: "active",
  tool: "call_connector",
  verb: "send",
  target: "POST /v1/messages/send",
  account: "4f0c2f6e-1a55-4d0b-9a59-0d6f5f3f6a11",
  connector: "4f0c2f6e-1a55-4d0b-9a59-0d6f5f3f6a11",
  operation: "POST /v1/messages/send",
  content_class: "person_given",
  expires_at: "2027-01-31T10:00:00.000Z",
  expired: false,
  daily_limit: 20,
  uses_today: 3,
  recipients: ["anna@firma.de"],
  approvals_count: 2,
  use_count: 7,
  offered_at: "2026-11-01T10:00:00.000Z",
  decided_at: "2026-11-02T10:00:00.000Z",
  revoked_at: null,
  last_used_at: "2026-11-19T08:00:00.000Z",
  created_at: "2026-10-30T10:00:00.000Z",
};

const named = namedConnector(rule, () => "Gmail");

function row(target: ApprovalRule, locale: "de" | "en" = "de"): string {
  return render(
    <RuleRow
      rule={target}
      busy={false}
      onRevoke={() => {}}
      onRenew={() => {}}
      onDecide={() => {}}
    />,
    locale,
  );
}

describe("what a rule covers", () => {
  test("the connector reads by its name and never as an identifier", () => {
    expect(named.connector).toBe("Gmail");
    expect(namedConnector(rule, () => null).connector).toBeNull();
    expect(namedConnector({ ...rule, connector: "gmail" }, () => null).connector).toBe("gmail");
  });

  test("scope, validity and today's use each have a fact of their own", () => {
    expect(ruleFacts(named, de, date).map((fact) => [fact.id, fact.value])).toEqual([
      ["verb", "Senden"],
      ["connector", "Gmail"],
      ["operation", "POST /v1/messages/send"],
      ["recipients", "anna@firma.de"],
      ["content", "Nur Text, den du selbst geschrieben oder im Chat als Entwurf gesehen hast"],
      ["validity", "Gilt bis 2027-01-31"],
      ["today", "Heute 3 von 20 genutzt"],
    ]);
    expect(ruleFacts(named, en, date).map((fact) => fact.value)).toContain("3 of 20 used today");
  });

  test("a rule without a recipient says so", () => {
    const facts = ruleFacts({ ...named, recipients: [] }, de, date);
    expect(facts.find((fact) => fact.id === "recipients")?.value).toBe("ohne Empfänger");
  });

  test("every content class reads as a sentence in both languages", () => {
    for (const contentClass of ["no_content", "same_content", "person_given"]) {
      expect(contentClassLine(contentClass, de)).not.toContain("rules.content");
      expect(contentClassLine(contentClass, en)).not.toContain("rules.content");
    }
    expect(contentClassLine("same_content", de)).toBe("Nur genau der Text, den du erlaubt hast");
    expect(contentClassLine("no_content", en)).toBe("Only actions that carry no text");
  });
});

describe("how long a rule applies", () => {
  test("an active rule names its end, an expired one says that it asks again", () => {
    expect(ruleValidity(rule)).toBe("until");
    expect(validityLine(rule, de, date)).toBe("Gilt bis 2027-01-31");
    const expired = { ...rule, expired: true, expires_at: "2026-11-01T10:00:00.000Z" };
    expect(ruleValidity(expired)).toBe("expired");
    expect(validityLine(expired, de, date)).toBe(
      "Abgelaufen am 2026-11-01. SubKit fragt wieder, bis du die Regel verlängerst.",
    );
    expect(validityLine({ ...expired, expires_at: null }, en, date)).toBe(
      "Expired. SubKit asks again until you renew the rule.",
    );
  });

  test("an offer states the ninety days and the daily limit before it is saved", () => {
    const offer = { ...rule, state: "offered" as const, expires_at: null, uses_today: 0 };
    expect(validityLine(offer, de, date)).toBe(
      "Gilt 90 Tage ab dem Speichern. Danach fragt SubKit wieder, bis du die Regel verlängerst.",
    );
    expect(todayLine(offer, de)).toBe("Höchstens 20-mal am Tag");
    expect(todayLine(offer, en)).toBe("At most 20 times a day");
  });
});

describe("the rule row", () => {
  test("an active rule offers renewing and revoking and names the rule on both", () => {
    const html = row(named);
    expect(html).toContain('data-testid="settings-rule-renew"');
    expect(html).toContain('data-testid="settings-rule-revoke"');
    expect(html).toContain('aria-label="Regel „Senden: POST /v1/messages/send“ verlängern"');
    expect(html).toContain('aria-label="Regel „Senden: POST /v1/messages/send“ widerrufen"');
    expect(html).toContain("Heute 3 von 20 genutzt");
    expect(html).toContain("Zuletzt genutzt 2026-11-19T08:00:00.000Z");
    expect(html).not.toContain("4f0c2f6e");
  });

  test("an expired rule is marked and still renewable", () => {
    const html = row({ ...named, expired: true }, "en");
    expect(html).toContain('data-rule-expired="true"');
    expect(html).toContain('aria-label="Expired"');
    expect(html).toContain('data-testid="settings-rule-renew"');
  });

  test("an offered rule is decided, never renewed or revoked", () => {
    const html = row({ ...named, state: "offered", expires_at: null });
    expect(html).toContain('data-testid="settings-rule-save"');
    expect(html).not.toContain('data-testid="settings-rule-renew"');
    expect(html).not.toContain('data-testid="settings-rule-revoke"');
    expect(html).toContain("Gilt 90 Tage ab dem Speichern");
  });
});
