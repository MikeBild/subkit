import type { Conversation } from "@/api/client";
import type { PatchCandidate, SkillCandidate } from "@/api/decisions";

export type DecisionKind = "patch" | "skill" | "conversation";
export type GroupMode = "none" | "kind" | "source";

export interface DecisionItem {
  kind: DecisionKind;
  /** Domain id used for the decision call — never rendered. */
  id: string;
  /** One-line summary; falls back to a translated label, never to an id. */
  title: string;
  /** What the decision acts on, as a name (workflow, scope, conversation). */
  target: string | null;
  waitingSince: string;
  classification: "safe" | "unsafe" | null;
}

/** Positions older than this move into their own rubric and turn the nav counter red. */
export const AGED_AFTER_DAYS = 3;

export function ageInDays(waitingSince: string, now: number): number {
  const started = Date.parse(waitingSince);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 86_400_000));
}

export function patchDecision(candidate: PatchCandidate, fallbackTitle: string): DecisionItem {
  const proposal = readProposal(candidate.diff);
  return {
    kind: "patch",
    id: candidate.id,
    title: proposal?.description?.trim() || fallbackTitle,
    target: candidate.workflow_name ?? null,
    waitingSince: candidate.created_at,
    classification: candidate.classification,
  };
}

export function skillDecision(candidate: SkillCandidate): DecisionItem {
  return {
    kind: "skill",
    id: candidate.id,
    title: candidate.title,
    target: candidate.scope,
    waitingSince: candidate.created_at,
    classification: null,
  };
}

export function conversationDecision(
  conversation: Conversation,
  fallbackTitle: string,
): DecisionItem {
  return {
    kind: "conversation",
    id: conversation.id,
    title: conversation.title?.trim() || conversation.last_message_excerpt?.trim() || fallbackTitle,
    target: null,
    waitingSince: conversation.updated_at,
    classification: null,
  };
}

function readProposal(diff: unknown): { description?: string } | null {
  if (typeof diff !== "object" || diff === null) return null;
  const proposal = (diff as { proposal?: unknown }).proposal;
  if (typeof proposal !== "object" || proposal === null) return null;
  const description = (proposal as { description?: unknown }).description;
  return { description: typeof description === "string" ? description : undefined };
}

/**
 * No decision kind carries a deadline today, so "expiring first" resolves to
 * conversation approvals first — they block a running conversation — and
 * oldest first within every kind.
 */
export function sortDecisions(items: readonly DecisionItem[]): DecisionItem[] {
  const rank: Record<DecisionKind, number> = { conversation: 0, patch: 1, skill: 2 };
  return [...items].sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return Date.parse(a.waitingSince) - Date.parse(b.waitingSince);
  });
}

export interface DecisionRubrics {
  current: DecisionItem[];
  aged: DecisionItem[];
}

export function splitByAge(items: readonly DecisionItem[], now: number): DecisionRubrics {
  const sorted = sortDecisions(items);
  return {
    current: sorted.filter((item) => ageInDays(item.waitingSince, now) < AGED_AFTER_DAYS),
    aged: sorted.filter((item) => ageInDays(item.waitingSince, now) >= AGED_AFTER_DAYS),
  };
}

export function hasOverdue(items: readonly DecisionItem[], now: number): boolean {
  return items.some((item) => ageInDays(item.waitingSince, now) >= AGED_AFTER_DAYS);
}

export function filterByKinds(
  items: readonly DecisionItem[],
  kinds: readonly DecisionKind[],
): DecisionItem[] {
  if (kinds.length === 0) return [...items];
  return items.filter((item) => kinds.includes(item.kind));
}

export interface DecisionGroup {
  key: string;
  items: DecisionItem[];
}

export function groupDecisions(items: readonly DecisionItem[], mode: GroupMode): DecisionGroup[] {
  if (mode === "none") return [{ key: "all", items: [...items] }];
  const groups = new Map<string, DecisionItem[]>();
  for (const item of items) {
    const key = mode === "kind" ? item.kind : (item.target ?? "");
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, items: grouped }));
}
