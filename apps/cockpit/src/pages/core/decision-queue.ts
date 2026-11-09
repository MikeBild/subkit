import type { DecidableKind, DecisionItem, DecisionKind } from "@/pages/decisions-model";

export const AGED_AFTER_DAYS = 3;
const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;

type DecisionUrgency = "expired" | "expiring" | "blocking" | "deferred";
export type DecisionTotals = { patch: number; skill: number; conversation: number };
export type DecisionRubrics = { current: DecisionItem[]; aged: DecisionItem[] };
export type UrgencyRubrics = {
  expired: DecisionItem[];
  blocking: DecisionItem[];
  deferred: DecisionRubrics;
};
export type OpenDecisionSubsets = { blocking: number; overdue: number; aging: number };
export type OpenDecisions = {
  total: number;
  decidable: number;
  byKind: Record<DecisionKind, number>;
  subsets: OpenDecisionSubsets;
  oldestAgeDays: number;
  capped: boolean;
};
export type BannerSubset = {
  blocking: number;
  overdue: number;
  count: number;
  total: number;
  atLeast: boolean;
  shown: boolean;
};
export type QueueDisplayState = "rows" | "filtered-empty" | "empty";
export type QueueKind = DecidableKind | "schedule";
export type SourceState = "answered" | "failed" | "not_permitted";
export type ReadableSources = { patches: boolean; skills: boolean; failing: boolean };
export type QueueChip = { kind: QueueKind; index: number; count: number | null; partial: boolean };

const QUEUE_KINDS: readonly QueueKind[] = ["patch", "skill", "schedule"];

function isDecidable(item: DecisionItem): boolean {
  return (
    item.kind !== "conversation" && item.detail.kind !== "conversation" && item.reviewable !== false
  );
}

export function ageInDays(waitingSince: string, now: number): number {
  const started = Date.parse(waitingSince);
  return Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 86_400_000));
}

function urgency(item: DecisionItem, now: number): DecisionUrgency {
  if (item.expiresAt) {
    const expires = Date.parse(item.expiresAt);
    if (!Number.isNaN(expires)) {
      if (expires <= now) return "expired";
      if (expires - now <= EXPIRING_WITHIN_MS) return "expiring";
    }
  }
  return item.kind === "conversation" ? "blocking" : "deferred";
}

export function sortDecisions(items: readonly DecisionItem[]): DecisionItem[] {
  const rank: Record<DecisionKind, number> = { conversation: 0, patch: 1, skill: 2 };
  return [...items].sort((a, b) => {
    const due = (item: DecisionItem) => {
      const value = item.expiresAt ? Date.parse(item.expiresAt) : Number.POSITIVE_INFINITY;
      return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
    };
    if (due(a) !== due(b)) return due(a) - due(b);
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return Date.parse(a.waitingSince) - Date.parse(b.waitingSince);
  });
}

export function splitByAge(items: readonly DecisionItem[], now: number): DecisionRubrics {
  const sorted = sortDecisions(items);
  return {
    current: sorted.filter((item) => ageInDays(item.waitingSince, now) < AGED_AFTER_DAYS),
    aged: sorted.filter((item) => ageInDays(item.waitingSince, now) >= AGED_AFTER_DAYS),
  };
}

export function partitionByUrgency(items: readonly DecisionItem[], now: number): UrgencyRubrics {
  const expired: DecisionItem[] = [],
    blocking: DecisionItem[] = [],
    deferred: DecisionItem[] = [];
  for (const item of sortDecisions(items)) {
    const value = urgency(item, now);
    if (value === "expired") expired.push(item);
    else if (value === "blocking" || value === "expiring") blocking.push(item);
    else deferred.push(item);
  }
  return { expired, blocking, deferred: splitByAge(deferred, now) };
}

export function hasOverdue(items: readonly DecisionItem[], now: number): boolean {
  return items.some((item) => {
    const value = urgency(item, now);
    return (
      value === "expired" ||
      value === "expiring" ||
      ageInDays(item.waitingSince, now) >= AGED_AFTER_DAYS
    );
  });
}

export function decisionKey(item: DecisionItem): string {
  return `${item.kind}:${item.id}`;
}

export function countOpenDecisions(input: {
  items: readonly DecisionItem[];
  totals: DecisionTotals | null;
  nowMs: number;
}): OpenDecisions {
  const seen = new Map<string, DecisionItem>();
  for (const item of input.items)
    if (!seen.has(decisionKey(item))) seen.set(decisionKey(item), item);
  const unique = [...seen.values()];
  const counted = input.totals
    ? { ...input.totals }
    : unique.reduce(
        (counts, item) => {
          if (item.kind === "conversation" || isDecidable(item)) counts[item.kind] += 1;
          return counts;
        },
        { patch: 0, skill: 0, conversation: 0 } as DecisionTotals,
      );
  const subsets: OpenDecisionSubsets = { blocking: 0, overdue: 0, aging: 0 };
  let oldestAgeDays = 0;
  for (const item of unique) {
    if (item.kind !== "conversation" && !isDecidable(item)) continue;
    const value = urgency(item, input.nowMs),
      age = ageInDays(item.waitingSince, input.nowMs);
    if (isDecidable(item) && age > oldestAgeDays) oldestAgeDays = age;
    if (value === "expired") subsets.overdue += 1;
    else if (value === "blocking" || value === "expiring") subsets.blocking += 1;
    else if (age >= AGED_AFTER_DAYS) subsets.aging += 1;
  }
  const total = counted.patch + counted.skill;
  return {
    total,
    decidable: total,
    byKind: { patch: counted.patch, skill: counted.skill, conversation: counted.conversation },
    subsets,
    oldestAgeDays,
    capped: unique.filter(isDecidable).length < total,
  };
}

export function bannerSubset(open: OpenDecisions): BannerSubset {
  const blocking = open.subsets.blocking,
    overdue = open.subsets.overdue,
    count = blocking + overdue,
    total = open.byKind.conversation;
  return {
    blocking,
    overdue,
    count,
    total,
    atLeast: open.capped && count > 0,
    shown: count > 0 && total > 0,
  };
}

export function filterByKinds(
  items: readonly DecisionItem[],
  kinds: readonly DecisionKind[],
): DecisionItem[] {
  return kinds.length === 0 ? [...items] : items.filter((item) => kinds.includes(item.kind));
}
export function queueDisplayState(input: {
  shown: number;
  held: number;
  failing: number;
  total: number;
  narrowed: boolean;
}): QueueDisplayState {
  return input.shown > 0 || input.held > 0 || input.failing > 0
    ? "rows"
    : input.narrowed && input.total > 0
      ? "filtered-empty"
      : "empty";
}
export function openDecisionQueue(input: {
  items: readonly DecisionItem[];
  totals: DecisionTotals | null;
  held: number;
  failing: number;
  nowMs: number;
}): OpenDecisions {
  const open = countOpenDecisions(input);
  return {
    ...open,
    total: open.total + input.held + input.failing,
    subsets: { ...open.subsets, blocking: open.subsets.blocking + input.held + input.failing },
  };
}
function readableQueueKinds(readable: ReadableSources): QueueKind[] {
  return QUEUE_KINDS.filter((kind) =>
    kind === "patch"
      ? readable.patches
      : kind === "skill"
        ? readable.skills
        : readable.patches || readable.failing,
  );
}
export function queueChips(input: {
  open: OpenDecisions | null;
  readable: ReadableSources;
  held: number;
  failing: { state: SourceState; count: number };
}): QueueChip[] | null {
  if (!input.open) return null;
  const failed = input.failing.state === "failed";
  return readableQueueKinds(input.readable).map((kind) => {
    const index = QUEUE_KINDS.indexOf(kind);
    if (kind !== "schedule")
      return { kind, index, count: input.open!.byKind[kind], partial: false };
    const held = input.readable.patches ? input.held : 0,
      failing = input.failing.state === "answered" ? input.failing.count : 0;
    return {
      kind,
      index,
      count: failed && !input.readable.patches ? null : held + failing,
      partial: failed && input.readable.patches,
    };
  });
}
export function badgeCount(chips: readonly QueueChip[] | null): number | null {
  if (!chips) return null;
  const total = chips.reduce((sum, chip) => sum + (chip.count ?? 0), 0);
  return total > 0 ? total : null;
}
export function searchWithoutBucket(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("bucket");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
