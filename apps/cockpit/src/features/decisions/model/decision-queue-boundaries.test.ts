import { expect, test } from "bun:test";
import {
  bannerSubset,
  countOpenDecisions,
  filterByKinds,
  hasOverdue,
  openDecisionQueue,
  partitionByUrgency,
  queueChips,
  sortDecisions,
  splitByAge,
} from "./decision-queue.ts";
import { item, NOW } from "./decisions-model-fixtures.ts";

test("equal deadlines prioritize conversations, then patches, then skills without changing input", () => {
  const deadline = new Date(NOW + 60_000).toISOString();
  const skill = item("skill", 10, "skill", { expiresAt: deadline });
  const patch = item("patch", 5, "patch", { expiresAt: deadline });
  const conversation = item("conversation", 0, "conversation", { expiresAt: deadline });
  const input = Object.freeze([skill, patch, conversation]);
  expect(sortDecisions(input).map((entry) => entry.id)).toEqual(["conversation", "patch", "skill"]);
  expect(input).toEqual([skill, patch, conversation]);
});

test("unreadable and absent deadlines use kind priority and oldest-first ordering", () => {
  const newer = item("patch", 1, "newer", { expiresAt: null });
  const older = item("patch", 5, "older", { expiresAt: "not-a-date" });
  const skill = item("skill", 10, "skill");
  const conversation = item("conversation", 0, "conversation");
  expect(sortDecisions([skill, newer, older, conversation]).map((entry) => entry.id)).toEqual([
    "conversation",
    "older",
    "newer",
    "skill",
  ]);
});

test("expiry boundaries partition review work at now and exactly one day ahead", () => {
  const expired = item("patch", 0, "expired", { expiresAt: new Date(NOW).toISOString() });
  const expiring = item("skill", 0, "expiring", {
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
  });
  const future = item("patch", 0, "future", {
    expiresAt: new Date(NOW + 86_400_001).toISOString(),
  });
  const invalid = item("skill", 3, "invalid", { expiresAt: "invalid" });
  const conversation = item("conversation", 0, "blocking");
  expect(partitionByUrgency([future, conversation, invalid, expiring, expired], NOW)).toEqual({
    expired: [expired],
    blocking: [expiring, conversation],
    deferred: { current: [future], aged: [invalid] },
  });
  expect(splitByAge([invalid, future], NOW)).toEqual({ current: [future], aged: [invalid] });
  for (const overdue of [expired, expiring, invalid]) {
    expect(hasOverdue([future, overdue], NOW)).toBe(true);
  }
  expect(hasOverdue([future, conversation], NOW)).toBe(false);
  expect(hasOverdue([], NOW)).toBe(false);
});

test("queue counts deduplicate identities and exclude nonreviewable work", () => {
  const patch = item("patch", 3, "same");
  const duplicate = item("patch", 10, "same");
  const skill = item("skill", 1, "same");
  const conversation = item("conversation", 20, "chat");
  const hidden = item("patch", 30, "hidden", { reviewable: false });
  const input = {
    items: [patch, duplicate, skill, conversation, hidden],
    totals: null,
    nowMs: NOW,
  };
  const open = countOpenDecisions(input);
  expect(open).toEqual({
    total: 2,
    decidable: 2,
    byKind: { patch: 1, skill: 1, conversation: 1 },
    subsets: { blocking: 1, overdue: 0, aging: 1 },
    oldestAgeDays: 3,
    capped: false,
  });
  expect(openDecisionQueue({ ...input, held: 2, failing: 4 })).toEqual({
    ...open,
    total: 8,
    subsets: { blocking: 7, overdue: 0, aging: 1 },
  });
  expect(bannerSubset(open)).toEqual({
    blocking: 1,
    overdue: 0,
    count: 1,
    total: 1,
    atLeast: false,
    shown: true,
  });
  expect(bannerSubset({ ...open, byKind: { ...open.byKind, conversation: 0 } }).shown).toBe(false);
  expect(filterByKinds([patch, skill], [])).toEqual([patch, skill]);
  expect(filterByKinds([patch, skill], ["skill"])).toEqual([skill]);
  expect(
    queueChips({
      open,
      readable: { patches: false, skills: true, failing: false },
      held: 10,
      failing: { state: "answered", count: 20 },
    }),
  ).toEqual([{ kind: "skill", index: 1, count: 1, partial: false }]);
});

test("nondecidable conversation details do not inflate totals or hide capped results", () => {
  const detail = {
    kind: "conversation" as const,
    evidence: { conversationId: "chat", targetWorkflowId: null, targetConnectorId: null },
    question: null,
    tool: null,
  };
  const items = [item("patch", 9, "chat-backed", { detail }), item("patch", 1, "patch")];
  expect(countOpenDecisions({ items, totals: null, nowMs: NOW })).toMatchObject({
    total: 1,
    oldestAgeDays: 1,
    byKind: { patch: 1, skill: 0, conversation: 0 },
  });
  const open = countOpenDecisions({
    items,
    totals: { patch: 2, skill: 0, conversation: 0 },
    nowMs: NOW,
  });
  expect(open.capped).toBe(true);
  expect(
    queueChips({
      open,
      readable: { patches: true, skills: false, failing: true },
      held: 2,
      failing: { state: "failed", count: 99 },
    }),
  ).toEqual([
    { kind: "patch", index: 0, count: 2, partial: false },
    { kind: "schedule", index: 2, count: 2, partial: true },
  ]);
});

test("oldest age preserves the maximum and treats an invalid clock as no age", () => {
  const items = [item("patch", 9, "older"), item("skill", 1, "newer")];
  expect(countOpenDecisions({ items, totals: null, nowMs: NOW }).oldestAgeDays).toBe(9);
  expect(countOpenDecisions({ items, totals: null, nowMs: Number.NaN }).oldestAgeDays).toBe(0);
  expect(
    countOpenDecisions({ items, totals: null, nowMs: Number.POSITIVE_INFINITY }).oldestAgeDays,
  ).toBe(Number.POSITIVE_INFINITY);
  expect(
    countOpenDecisions({ items, totals: null, nowMs: Number.NEGATIVE_INFINITY }).oldestAgeDays,
  ).toBe(0);
});
