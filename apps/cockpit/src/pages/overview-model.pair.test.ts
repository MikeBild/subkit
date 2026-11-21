import { describe, expect, test } from "bun:test";
import { needVisual } from "@/features/operations/model";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  type Attention,
  type AttentionItem,
  attentionBadge,
  attentionReason,
  attentionRow,
  attentionSentence,
  entryActions,
  pairWaitingFor,
  sentenceText,
} from "./overview-model";
import { de, item, NOW, W } from "./overview-model-fixtures.ts";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const pair = (overrides: Partial<AttentionItem> = {}): AttentionItem =>
  item({
    id: `pair:${W}`,
    kind: "pair_approval",
    class: "decide",
    subject: { kind: "workflow", id: W, name: "Rechnungen", environment: "prod" },
    reason: "pair_approval_requested",
    since: null,
    actions: [
      {
        verb: "review",
        href: `/cockpit/workflows/${W}`,
        primary: true,
        permission: "workflow:write",
      },
    ],
    ...overrides,
  });

const waiting = (overrides: Partial<AttentionItem> = {}) =>
  pair({ kind: "pair_approval_waiting", ...overrides });

describe("pair approval attention", () => {
  test("the second person sees the request with a review action", () => {
    const entry = pair();
    expect(attentionReason(entry)).toBe("pair_approval_requested");
    expect(entryActions(entry).primary?.verb).toBe("review");
    expect(sentenceText(attentionSentence(entry, de, NOW))).toContain(
      "wartet auf deine zweite Freigabe",
    );
    expect(de(attentionRow(entry, de).badge.label)).toBe(de("ops.pair.waitingSecond"));
    expect(attentionRow(entry, de).reason).toBe("Zweite Freigabe fehlt");
    expect(needVisual(attentionReason(entry))).toEqual({ tone: "info", icon: "approval" });
  });

  test("the requester waits on the named partner and gets no action", () => {
    const entry = waiting({ waiting_on: { user_id: W, name: "Anna" } });
    expect(attentionReason(entry)).toBe("pair_approval_waiting");
    expect(entryActions(entry)).toEqual({ primary: null, secondary: null });
    expect(sentenceText(attentionSentence(entry, de, NOW))).toContain("wartet auf Anna");
    expect(attentionRow(entry, de).reason).toBe("Freigabe angefragt");
    expect(attentionRow(entry, de).waitingOn).toBe("Wartet auf Freigabe von Anna");
    expect(de(attentionRow(entry, de).badge.label)).toBe("Wartet");
    expect(needVisual(attentionReason(entry))).toEqual({ tone: "neutral", icon: "approval" });
  });

  test("without a named partner the requester waits for a second person", () => {
    const entry = waiting();
    expect(entryActions(entry).primary).toBeNull();
    expect(sentenceText(attentionSentence(entry, de, NOW))).toContain(
      "wartet auf eine zweite Person",
    );
    expect(attentionRow(entry, de).reason).toBe(
      "Freigabe angefragt, wartet auf eine zweite Person",
    );
    expect(attentionRow(entry, de).waitingOn).toBeNull();
  });

  test("English reads the same way", () => {
    const entry = waiting({ waiting_on: { user_id: W, name: "Anna" } });
    expect(sentenceText(attentionSentence(entry, en, NOW))).toContain("waiting for Anna");
    expect(attentionRow(pair(), en).reason).toBe("Second approval missing");
  });
});

describe("the requester's own waiting item", () => {
  const attention = (items: AttentionItem[]) => ({ items }) as unknown as Attention;

  test("does not count as something that needs you", () => {
    expect(attentionBadge(attention([waiting()]))).toBeNull();
    expect(attentionBadge(attention([pair()]))?.count).toBe(1);
  });

  test("the chat finds it for its workflow and names who it waits for", () => {
    const named = attention([waiting({ waiting_on: { user_id: W, name: "Anna" } })]);
    expect(pairWaitingFor(named, W)).toEqual({ waitingOn: "Anna" });
    expect(pairWaitingFor(attention([waiting()]), W)).toEqual({ waitingOn: null });
    expect(pairWaitingFor(attention([pair()]), W)).toBeNull();
    expect(pairWaitingFor(named, "other")).toBeNull();
  });
});
