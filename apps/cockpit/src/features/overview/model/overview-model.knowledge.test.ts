import { describe, expect, test } from "bun:test";
import { routerPath } from "@/app/links";
import { type TranslationKey, translate } from "@/lib/i18n";
import { attentionRow, attentionSentence, sentenceText } from "./overview-model";
import { item, NOW } from "./overview-model-fixtures.ts";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("knowledge sources due for a review", () => {
  const SOURCE = "11111111-1111-4111-8111-111111111111";
  const one = item({
    id: `knowledge_review:${SOURCE}`,
    class: "decide",
    severity: "notice",
    kind: "knowledge_review",
    subject: { kind: "knowledge", id: SOURCE, name: "Runbook" },
    reason: "knowledge_review_due",
    counts: { knowledge_reviews: 1 },
    detail: null,
    actions: [
      {
        verb: "review",
        href: `/cockpit/knowledge/${SOURCE}`,
        primary: true,
        permission: "knowledge:read",
      },
    ],
  });
  const several = item({
    ...one,
    id: "knowledge_review",
    subject: null,
    counts: { knowledge_reviews: 3 },
    actions: [{ ...one.actions[0]!, href: "/cockpit/knowledge" }],
  });

  test("one due source is named in the sentence", () => {
    expect(sentenceText(attentionSentence(one, en, NOW))).toBe(
      "The knowledge source “Runbook” is due for a review — for 3 days.",
    );
    expect(attentionRow(one, en).name).toBe("Runbook");
  });

  test("several due sources are counted and the row names the knowledge sources", () => {
    expect(sentenceText(attentionSentence(several, en, NOW))).toBe(
      "3 knowledge sources are due for a review — for 3 days.",
    );
    expect(attentionRow(several, en).name).toBe("Knowledge sources");
    expect(routerPath(several.actions[0]!.href)).toBe("/knowledge");
  });
});
