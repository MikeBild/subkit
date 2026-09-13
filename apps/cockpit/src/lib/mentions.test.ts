import { describe, expect, test } from "bun:test";

import {
  candidateToReference,
  type ConversationReference,
  dedupeReferences,
  findMentionQuery,
  findTokenAt,
  insertMention,
  isInsideMentionToken,
  isMentionableLabel,
  mentionTokenText,
  rankCandidates,
  reconcileReferences,
  scanMentionTokens,
  splitByMentions,
} from "./mentions";

const wf = (label: string, id = `${label}-id`): ConversationReference => ({
  type: "workflow",
  id,
  label,
});
const conn = (label: string, id = `${label}-id`): ConversationReference => ({
  type: "connector",
  id,
  label,
});

describe("findMentionQuery", () => {
  test("detects the query when the caret sits inside an @ token", () => {
    expect(findMentionQuery("run @cust", 9)).toEqual({ start: 4, query: "cust" });
  });
  test("detects a bare @ at the start of the text", () => {
    expect(findMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });
  test("returns null when there is no @ before the caret", () => {
    expect(findMentionQuery("hello", 5)).toBeNull();
  });
  test("does not trigger inside an e-mail address", () => {
    expect(findMentionQuery("mail ops@customer", 17)).toBeNull();
  });
  test("closes once the user types whitespace after the query", () => {
    expect(findMentionQuery("@cust now", 9)).toBeNull();
  });
  test("returns null when the caret is out of bounds", () => {
    expect(findMentionQuery("@a", 5)).toBeNull();
  });
});

describe("insertMention", () => {
  test("replaces the in-progress token and places the caret after it", () => {
    const out = insertMention("run @cust", 4, 9, wf("customer-sync"));
    expect(out.text).toBe("run @customer-sync ");
    expect(out.caret).toBe(out.text.length);
  });
  test("keeps text after the caret", () => {
    const out = insertMention("run @cu please", 4, 7, wf("customer-sync"));
    expect(out.text).toBe("run @customer-sync  please");
  });
});

describe("scanMentionTokens", () => {
  test("prefers the longer token when one token is a prefix of another", () => {
    const refs = [wf("sync"), wf("sync-orders")];
    const matches = scanMentionTokens("run @sync-orders now", refs);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reference.label).toBe("sync-orders");
  });
  test("does not match a token inside an e-mail address", () => {
    expect(scanMentionTokens("mail ops@customer-sync.io", [wf("customer-sync")])).toEqual([]);
  });
  test("tags every occurrence of a repeated token", () => {
    const matches = scanMentionTokens("@a and @a", [wf("a")]);
    expect(matches.map((m) => m.start)).toEqual([0, 7]);
  });
  test("distributes occurrences across same-labelled references", () => {
    const refs = [conn("stripe", "dev"), conn("stripe", "prod")];
    const matches = scanMentionTokens("@stripe vs @stripe", refs);
    expect(matches.map((m) => m.reference.id)).toEqual(["dev", "prod"]);
  });
  test("returns nothing for empty input", () => {
    expect(scanMentionTokens("", [wf("a")])).toEqual([]);
    expect(scanMentionTokens("@a", [])).toEqual([]);
  });
  test("a sentence-ending dot after the token is punctuation, not part of it", () => {
    expect(scanMentionTokens("run @customer-sync.", [wf("customer-sync")])).toHaveLength(1);
    expect(scanMentionTokens("run @customer-sync. Then", [wf("customer-sync")])).toHaveLength(1);
  });
  test("a dotted longer label still shadows its prefix", () => {
    expect(scanMentionTokens("use @stripe.prod now", [conn("stripe")])).toEqual([]);
    expect(
      scanMentionTokens("use @stripe.prod now", [conn("stripe"), conn("stripe.prod")]),
    ).toMatchObject([{ reference: conn("stripe.prod") }]);
  });
});

describe("reconcileReferences", () => {
  test("keeps references whose token still appears", () => {
    expect(reconcileReferences("run @a and @b", [wf("a"), wf("b")])).toHaveLength(2);
  });
  test("drops every reference when all tokens were deleted", () => {
    expect(reconcileReferences("run it", [wf("a")])).toEqual([]);
  });
  test("drops a reference whose token is only a prefix of another token", () => {
    expect(reconcileReferences("run @sync-orders", [wf("sync"), wf("sync-orders")])).toEqual([
      wf("sync-orders"),
    ]);
  });
  test("drops only the surplus same-labelled reference when one occurrence remains", () => {
    const refs = [conn("stripe", "dev"), conn("stripe", "prod")];
    expect(reconcileReferences("@stripe", refs)).toEqual([conn("stripe", "dev")]);
  });
});

describe("dedupeReferences", () => {
  test("removes duplicates while keeping the first occurrence", () => {
    expect(dedupeReferences([wf("a"), wf("a"), wf("b")])).toEqual([wf("a"), wf("b")]);
  });
  test("keeps different types with the same id apart", () => {
    expect(dedupeReferences([wf("a", "x"), conn("a", "x")])).toHaveLength(2);
  });
});

describe("splitByMentions", () => {
  test("returns one plain segment when there are no references", () => {
    expect(splitByMentions("hello", [])).toEqual([{ text: "hello" }]);
  });
  test("tags mention tokens with their reference", () => {
    expect(splitByMentions("run @a now", [wf("a")])).toEqual([
      { text: "run " },
      { text: "@a", reference: wf("a") },
      { text: " now" },
    ]);
  });
  test("returns no segments for empty text", () => {
    expect(splitByMentions("", [wf("a")])).toEqual([]);
  });
});

describe("findTokenAt", () => {
  const refs = [wf("customer-sync")];
  const text = "run @customer-sync twice";
  test("returns the token range when the index is inside a token", () => {
    expect(findTokenAt(text, refs, 6)).toMatchObject({ start: 4, end: 18 });
  });
  test("hits at the first character and misses right after the token", () => {
    expect(findTokenAt(text, refs, 4)).not.toBeNull();
    expect(findTokenAt(text, refs, 18)).toBeNull();
  });
  test("returns null in plain text and out of bounds", () => {
    expect(findTokenAt(text, refs, 1)).toBeNull();
    expect(findTokenAt(text, refs, 99)).toBeNull();
  });
});

describe("isInsideMentionToken", () => {
  const refs = [wf("customer-sync")];
  test("true strictly inside, false at both edges", () => {
    expect(isInsideMentionToken("@customer-sync", refs, 3)).toBe(true);
    expect(isInsideMentionToken("@customer-sync", refs, 0)).toBe(false);
    expect(isInsideMentionToken("@customer-sync", refs, 14)).toBe(false);
  });
  test("false in plain text and with no references", () => {
    expect(isInsideMentionToken("hello", refs, 2)).toBe(false);
    expect(isInsideMentionToken("@customer-sync", [], 3)).toBe(false);
  });
});

describe("labels and candidates", () => {
  test("mentionTokenText prepends the trigger", () => {
    expect(mentionTokenText(wf("a"))).toBe("@a");
  });
  test("a mentionable label is one word in the engine's charset", () => {
    expect(isMentionableLabel("customer-sync")).toBe(true);
    expect(isMentionableLabel("stripe.prod")).toBe(true);
    expect(isMentionableLabel("two words")).toBe(false);
    expect(isMentionableLabel("bad<label>")).toBe(false);
    expect(isMentionableLabel("")).toBe(false);
  });
  test("rankCandidates puts prefix matches before substring matches", () => {
    const candidates = [
      {
        type: "workflow" as const,
        id: "1",
        label: "orders-customer",
        title: "Orders per customer",
      },
      { type: "workflow" as const, id: "2", label: "customer-sync", title: "Customer sync" },
      { type: "connector" as const, id: "3", label: "stripe", title: "Stripe" },
    ];
    expect(rankCandidates(candidates, "cust").map((c) => c.id)).toEqual(["2", "1"]);
    expect(rankCandidates(candidates, "").map((c) => c.id)).toEqual(["1", "2", "3"]);
  });
  test("candidateToReference keeps type, id and the slug label only", () => {
    expect(
      candidateToReference({ type: "connector", id: "3", label: "stripe", title: "Stripe" }),
    ).toEqual({ type: "connector", id: "3", label: "stripe" });
  });
});
