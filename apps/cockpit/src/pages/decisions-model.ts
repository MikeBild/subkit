import type { Conversation } from "@/api/client";
import type { PatchCandidate, SkillCandidate } from "@/api/decisions";
import { conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";

export type DecisionKind = "patch" | "skill" | "conversation";
export type GroupMode = "none" | "kind" | "source";

/** Where a position came from — the sentence that answers "why am I seeing this". */
export type DecisionOrigin =
  | "observedFailure"
  | "repairPattern"
  | "failurePattern"
  | "successPattern"
  | "authoringPattern"
  | "sessionPattern"
  | "chainedPattern"
  | "recurringPattern"
  | "conversation";

/**
 * Whether this position is holding something up.
 *
 * A conversation in `awaiting_input` genuinely blocks: an elicitation row is
 * pending and the agent loop is suspended mid-turn, so nothing in that
 * conversation proceeds until a person answers. A proposed fix or skill blocks
 * nothing — the workflow keeps running, and keeps failing, which is the cost of
 * leaving it. Sorting those two together by age alone put the thing nobody is
 * waiting on above the thing that is stopped dead.
 */
export type DecisionUrgency = "expired" | "expiring" | "blocking" | "deferred";

export interface DecisionItem {
  kind: DecisionKind;
  /** Domain id used for the decision call — never rendered. */
  id: string;
  /** One-line summary; falls back to a translated label, never to an id. */
  title: string;
  /** What the decision acts on, as a name (workflow, scope, conversation). */
  target: string | null;
  /** Where it came from, so the queue never shows an unexplained position. */
  origin: DecisionOrigin;
  waitingSince: string;
  classification: "safe" | "unsafe" | null;
  /** When this position lapses. Only a waiting conversation has one. */
  expiresAt: string | null;
  /** The model's own confidence in a proposed skill, and what it rests on. */
  confidence: "low" | "medium" | "high" | null;
  evidenceCount: number | null;
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
    origin: "observedFailure",
    waitingSince: candidate.created_at,
    classification: candidate.classification,
    expiresAt: null,
    confidence: null,
    evidenceCount: null,
  };
}

/** The pattern a skill was distilled from, as an origin the queue can say. */
const SKILL_ORIGIN: Record<string, DecisionOrigin> = {
  repair_pattern: "repairPattern",
  failure_pattern: "failurePattern",
  success_pattern: "successPattern",
  authoring_capability: "authoringPattern",
  session_learning: "sessionPattern",
  chained_workflow_pattern: "chainedPattern",
};

export function skillDecision(
  candidate: SkillCandidate,
  targetName: string | null = null,
): DecisionItem {
  return {
    kind: "skill",
    id: candidate.id,
    title: candidate.title,
    // `scope` is an enum word — rendering it made the card say "workflow" where
    // a person expected the name of one. A resolved name or nothing.
    target: targetName,
    origin: SKILL_ORIGIN[candidate.pattern_kind ?? ""] ?? "recurringPattern",
    waitingSince: candidate.created_at,
    classification: null,
    expiresAt: null,
    confidence: candidate.confidence ?? null,
    evidenceCount: typeof candidate.evidence_count === "number" ? candidate.evidence_count : null,
  };
}

export interface ConversationLabels {
  fallbackTitle: string;
  toolActivity: string;
  hiddenReference: string;
}

/**
 * A conversation excerpt is raw model output — it carries tool JSON and
 * elicitation ids — so it passes through the same redaction the transcript
 * uses before it can become a title.
 */
export function conversationDecision(
  conversation: Conversation,
  labels: ConversationLabels,
  targetName: string | null = null,
): DecisionItem {
  const title =
    conversation.title?.trim() ||
    conversationExcerpt(
      conversation.last_message_excerpt,
      labels.toolActivity,
      labels.hiddenReference,
    ) ||
    labels.fallbackTitle;
  return {
    kind: "conversation",
    id: conversation.id,
    title: hideTechnicalIdentifiers(title, labels.hiddenReference),
    target: targetName,
    origin: "conversation",
    waitingSince: conversation.updated_at,
    classification: null,
    expiresAt: conversation.pending_elicitation_expires_at ?? null,
    confidence: null,
    evidenceCount: null,
  };
}

function readProposal(diff: unknown): { description?: string } | null {
  if (typeof diff !== "object" || diff === null) return null;
  const proposal = (diff as { proposal?: unknown }).proposal;
  if (typeof proposal !== "object" || proposal === null) return null;
  const description = (proposal as { description?: unknown }).description;
  return { description: typeof description === "string" ? description : undefined };
}

/** A deadline closer than this makes a position urgent rather than merely open. */
export const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * What this position is doing to the person who has not decided it yet.
 *
 * A waiting conversation is stopped, not slow: an elicitation is pending and
 * the agent loop is suspended mid-turn. A proposed fix or skill is the
 * opposite — nothing waits on it, but the workflow it would repair keeps
 * running and keeps failing, which is why age is the thing that matters there.
 */
export function decisionUrgency(item: DecisionItem, now: number): DecisionUrgency {
  if (item.expiresAt) {
    const expires = Date.parse(item.expiresAt);
    if (!Number.isNaN(expires)) {
      if (expires <= now) return "expired";
      if (expires - now <= EXPIRING_WITHIN_MS) return "expiring";
    }
  }
  return item.kind === "conversation" ? "blocking" : "deferred";
}

/**
 * Nearest deadline first, then what blocks, then oldest.
 *
 * The deadline key is new: until the engine put the elicitation's `expires_at`
 * on the wire there was nothing here to sort by, and "expiring first" could
 * only be approximated by putting conversations on top.
 */
export function sortDecisions(items: readonly DecisionItem[]): DecisionItem[] {
  const rank: Record<DecisionKind, number> = { conversation: 0, patch: 1, skill: 2 };
  return [...items].sort((a, b) => {
    const aExpiry = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
    const bExpiry = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
    const aDue = Number.isNaN(aExpiry) ? Number.POSITIVE_INFINITY : aExpiry;
    const bDue = Number.isNaN(bExpiry) ? Number.POSITIVE_INFINITY : bExpiry;
    if (aDue !== bDue) return aDue - bDue;
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

export interface UrgencyRubrics {
  /** Past its deadline — the conversation can no longer be answered. */
  expired: DecisionItem[];
  /** Stopping something right now, soonest deadline first. */
  blocking: DecisionItem[];
  /** Blocking nothing, split by how long it has been sitting. */
  deferred: DecisionRubrics;
}

/**
 * The top-level split of the queue.
 *
 * Age still separates the deferred pile — that rubric is the honest measure
 * there — but it is no longer the FIRST question, because a three-hour-old
 * conversation that is stopped dead outranks a three-day-old proposal that
 * nothing is waiting on.
 */
export function partitionByUrgency(items: readonly DecisionItem[], now: number): UrgencyRubrics {
  const sorted = sortDecisions(items);
  const expired: DecisionItem[] = [];
  const blocking: DecisionItem[] = [];
  const deferred: DecisionItem[] = [];
  for (const item of sorted) {
    const urgency = decisionUrgency(item, now);
    if (urgency === "expired") expired.push(item);
    else if (urgency === "blocking" || urgency === "expiring") blocking.push(item);
    else deferred.push(item);
  }
  return { expired, blocking, deferred: splitByAge(deferred, now) };
}

/** True when something in the queue is late enough to warrant a red counter. */
export function hasOverdue(items: readonly DecisionItem[], now: number): boolean {
  return items.some((item) => {
    const urgency = decisionUrgency(item, now);
    if (urgency === "expired" || urgency === "expiring") return true;
    return ageInDays(item.waitingSince, now) >= AGED_AFTER_DAYS;
  });
}

/** How many positions each source contributed — the queue's own breakdown. */
export function countByKind(items: readonly DecisionItem[]): Record<DecisionKind, number> {
  const counts: Record<DecisionKind, number> = { patch: 0, skill: 0, conversation: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
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
