import { type TranslationKey, translate } from "@/lib/i18n";
import type { AttentionItem } from "./overview-model";

export const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

export const NOW = Date.parse("2026-09-28T12:00:00.000Z");

export const W = "018f4b4a-6d33-7b3a-9c2d-123456789abc";

export const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

export function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `workflow:${W}`,
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id: W, name: "Monatsbericht" },
    reason: "failing",
    trigger: null,
    cause_class: null,
    counts: {},
    since: daysAgo(3),
    deadline: null,
    detail: null,
    actions: [],
    ...overrides,
  };
}
