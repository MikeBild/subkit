import type { Conversation } from "@/api/client";
import type { PatchCandidate, SkillCandidate } from "@/api/decisions";
import type { TranslationKey } from "@/lib/i18n";
import { clipAtWord, conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import type { ConversationEvidence, PatchEvidence, SkillEvidence } from "./decisions-context";

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
  /** One concrete sentence about what this position actually is — the proposed
   *  change, the opening of the skill text, the question being asked. Distinct
   *  from `title`, which is a name. */
  summary: string | null;
  /** Everything the expanded panel needs. Carried rather than re-fetched: it
   *  all arrived with the list, and dropping it here is what made a reviewer
   *  approve things they could not see. */
  detail: DecisionDetail;
}

/** The kind-specific evidence an expanded card renders. */
export type DecisionDetail =
  | { kind: "patch"; evidence: PatchEvidence }
  | { kind: "skill"; evidence: SkillEvidence; body: string; sections: SkillSections }
  | {
      kind: "conversation";
      evidence: ConversationEvidence;
      question: string | null;
      tool: string | null;
    };

/** The four lists a proposed skill carries beside its body. */
export interface SkillSections {
  examples: string[];
  bestPractices: string[];
  pitfalls: string[];
  docRefs: string[];
  tags: string[];
}

/** Positions older than this move into their own rubric and turn the nav counter red. */
export const AGED_AFTER_DAYS = 3;

export function ageInDays(waitingSince: string, now: number): number {
  const started = Date.parse(waitingSince);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 86_400_000));
}

/** The two names the engine gives a proposed change, in the order to prefer them. */
export function patchChangeKind(candidate: PatchCandidate): {
  proposalKind: string | null;
  driftKind: string | null;
} {
  const envelope = readDiffEnvelope(candidate.diff);
  return { proposalKind: envelope.proposalKind, driftKind: envelope.driftKind };
}

/** Which sentence a correction card is titled with, and what fills it. */
export interface PatchTitle {
  key: TranslationKey;
  params: Record<string, string>;
}

/**
 * The summary line a correction card carries instead of the engine's own text.
 *
 * `proposal.description` is written by the repair model and passed through the
 * engine verbatim — it is English, it is a change note ("Field follows the
 * rename: data.id → data.result.id"), and it was the card's TITLE. §5 asks the
 * opposite of that: German on the top level, a summary rather than the raw
 * artefact, and the English detail one layer down. The description keeps its
 * place as the card's summary line; the title is composed here from what the
 * decision is about — the workflow it would repair and the kind of change.
 */
export function patchTitle(input: { workflow: string | null; change: string | null }): PatchTitle {
  const workflow = input.workflow?.trim() || null;
  const change = input.change?.trim() || null;
  if (workflow && change) return { key: "decisions.patchTitle", params: { workflow, change } };
  if (workflow) return { key: "decisions.patchTitleWorkflow", params: { workflow } };
  if (change) return { key: "decisions.patchTitleChange", params: { change } };
  return { key: "decisions.fallbackTitle.patch", params: {} };
}

export function patchDecision(candidate: PatchCandidate, title: string): DecisionItem {
  const envelope = readDiffEnvelope(candidate.diff);
  return {
    kind: "patch",
    id: candidate.id,
    title,
    target: candidate.workflow_name ?? null,
    origin: "observedFailure",
    waitingSince: candidate.created_at,
    classification: candidate.classification,
    expiresAt: null,
    confidence: null,
    evidenceCount: null,
    summary: envelope.description?.trim() ?? null,
    detail: {
      kind: "patch",
      evidence: {
        workflowId: candidate.workflow_id ?? null,
        workflowName: candidate.workflow_name ?? null,
        connectorId: candidate.connector_id ?? null,
        endpointKey: candidate.endpoint_key ?? null,
        executionId: envelope.executionId,
        driftKind: envelope.driftKind,
        driftSummary: envelope.driftSummary,
        reasoning: envelope.reasoning,
        proposalKind: envelope.proposalKind,
        classificationReasons: envelope.classificationReasons,
        rejections: envelope.rejections,
      },
    },
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
    summary: firstParagraph(candidate.body),
    detail: {
      kind: "skill",
      evidence: {
        scope: candidate.scope,
        workflowId: candidate.workflow_id ?? null,
        connectorId: candidate.connector_id ?? null,
        endpointKey: candidate.endpoint_key ?? null,
        evidenceCount:
          typeof candidate.evidence_count === "number" ? candidate.evidence_count : null,
      },
      body: candidate.body ?? "",
      sections: {
        examples: stringList(candidate.examples),
        bestPractices: stringList(candidate.best_practices),
        pitfalls: stringList(candidate.pitfalls),
        docRefs: stringList(candidate.doc_refs),
        tags: stringList(candidate.tags),
      },
    },
  };
}

/**
 * How much of a question the collapsed card shows.
 *
 * Long enough that most real questions arrive whole — the median pending prompt
 * is shorter than this — and short enough that a queue of a hundred stays a
 * queue rather than a wall of prose.
 */
export const QUESTION_LINE_MAX = 180;

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
    // The question, not the title. A queue that says only "waiting for your
    // answer" makes a person open every entry to find the one they can answer.
    //
    // Clipped here and whole below: the collapsed line has to stay scannable
    // across a queue of a hundred, and the panel has to be worth opening. The
    // engine sends the question in full precisely so this split is the
    // surface's to make.
    summary: conversation.pending_elicitation_summary
      ? clipAtWord(
          hideTechnicalIdentifiers(
            conversation.pending_elicitation_summary,
            labels.hiddenReference,
          ),
          QUESTION_LINE_MAX,
        )
      : null,
    detail: {
      kind: "conversation",
      evidence: {
        conversationId: conversation.id,
        targetWorkflowId: conversation.target_workflow_id ?? null,
        targetConnectorId: conversation.target_connector_id ?? null,
      },
      question: conversation.pending_elicitation_summary
        ? hideTechnicalIdentifiers(conversation.pending_elicitation_summary, labels.hiddenReference)
        : null,
      tool: conversation.pending_elicitation_tool ?? null,
    },
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** The opening of a skill body — enough to know what it claims, not the whole text. */
function firstParagraph(body: unknown): string | null {
  const text = str(body);
  if (!text) return null;
  const paragraph = text
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return paragraph && paragraph.length > 0 ? paragraph : null;
}

/**
 * Everything a patch candidate's `diff` blob carries.
 *
 * The engine ships this whole envelope with the list as `z.unknown()`. Reading
 * only `proposal.description` out of it — which is what this used to do — left
 * the reviewer without the cause, the reasoning, the failing run or the
 * classifier's argument, all of which were already in hand.
 */
function readDiffEnvelope(diff: unknown): {
  description: string | null;
  reasoning: string | null;
  proposalKind: string | null;
  driftKind: string | null;
  driftSummary: string | null;
  executionId: string | null;
  classificationReasons: string[];
  rejections: string[];
} {
  const empty = {
    description: null,
    reasoning: null,
    proposalKind: null,
    driftKind: null,
    driftSummary: null,
    executionId: null,
    classificationReasons: [],
    rejections: [],
  };
  if (typeof diff !== "object" || diff === null) return empty;
  const envelope = diff as Record<string, unknown>;
  const proposal =
    typeof envelope.proposal === "object" && envelope.proposal !== null
      ? (envelope.proposal as Record<string, unknown>)
      : {};
  const signal =
    typeof envelope.drift_signal === "object" && envelope.drift_signal !== null
      ? (envelope.drift_signal as Record<string, unknown>)
      : {};
  const rejections = Array.isArray(envelope.rejection_chain)
    ? envelope.rejection_chain
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? str((entry as Record<string, unknown>).reason)
            : null,
        )
        .filter((reason): reason is string => reason !== null)
    : [];
  return {
    description: str(proposal.description),
    reasoning: str(proposal.reasoning),
    proposalKind: str(proposal.kind),
    driftKind: str(signal.kind),
    driftSummary: str(envelope.drift_diff),
    executionId: str(envelope.execution_id),
    classificationReasons: stringList(envelope.classification_reasons),
    rejections,
  };
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

/** The engine's exact per-source counts. Three lists, three numbers, one sum. */
export interface DecisionTotals {
  patch: number;
  skill: number;
  conversation: number;
}

/**
 * The three states, disjoint by construction.
 *
 * Each is the count of exactly one rubric on the decisions page, which is what
 * lets another surface name a subset without contradicting the page it links
 * to: `blocking` is the "blocking" rubric, `overdue` is the "expired" one, and
 * `aging` is the aged rubric — which sits under a heading that says it blocks
 * nothing, and must therefore never be counted as something that does.
 */
export interface OpenDecisionSubsets {
  /** Stopping something right now — blocking or inside its deadline. */
  blocking: number;
  /** Past its deadline, so it stopped being decidable rather than blocking. */
  overdue: number;
  /** Blocking nothing, and sitting long enough that the queue says so. */
  aging: number;
}

export interface OpenDecisions {
  /** Every open position, counted once. The one number every surface shows. */
  total: number;
  byKind: Record<DecisionKind, number>;
  subsets: OpenDecisionSubsets;
  /** Age of the oldest position the page actually holds, in whole days. */
  oldestAgeDays: number;
  /** True when the engine counted more than the page was handed — every source
   *  is fetched with a page cap, and a number that silently disagrees with the
   *  list under it is what made three surfaces show three answers. */
  capped: boolean;
}

/** The dedup key. Two sources can hand out the same row; one position is one decision. */
export function decisionKey(item: DecisionItem): string {
  return `${item.kind}:${item.id}`;
}

/**
 * The one count behind the navigation badge, Zone A and the incident banner.
 *
 * Before this there were three: the banner filtered the health digest's own
 * `stuck` flag, Zone A read the digest's `patch_candidates.pending`, and the
 * badge summed three list endpoints — so the same queue was 25, 30 and 119 on
 * one screen. The digest knows only patch candidates and cannot answer for the
 * queue, which is why the digest is no longer asked: the totals come from the
 * three endpoints that own the three lists, and everything else here is derived
 * from the positions themselves, by an age and urgency rule a test can state.
 */
export function countOpenDecisions(input: {
  items: readonly DecisionItem[];
  totals: DecisionTotals | null;
  nowMs: number;
}): OpenDecisions {
  const seen = new Map<string, DecisionItem>();
  for (const item of input.items) {
    const key = decisionKey(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  const unique = [...seen.values()];
  const counted = input.totals
    ? { ...input.totals }
    : unique.reduce(
        (counts, item) => {
          counts[item.kind] += 1;
          return counts;
        },
        { patch: 0, skill: 0, conversation: 0 } as DecisionTotals,
      );
  const total = counted.patch + counted.skill + counted.conversation;
  const subsets: OpenDecisionSubsets = { blocking: 0, overdue: 0, aging: 0 };
  let oldestAgeDays = 0;
  for (const item of unique) {
    const urgency = decisionUrgency(item, input.nowMs);
    const age = ageInDays(item.waitingSince, input.nowMs);
    if (age > oldestAgeDays) oldestAgeDays = age;
    if (urgency === "expired") subsets.overdue += 1;
    else if (urgency === "blocking" || urgency === "expiring") subsets.blocking += 1;
    else if (age >= AGED_AFTER_DAYS) subsets.aging += 1;
  }
  return {
    total,
    byKind: { patch: counted.patch, skill: counted.skill, conversation: counted.conversation },
    subsets,
    oldestAgeDays,
    capped: unique.length < total,
  };
}

/**
 * What the incident banner may claim, and about how many.
 *
 * Only the two states §8.7 names: something is stopped right now, or a deadline
 * passed unanswered. A position that merely sat is deliberately NOT in here.
 * The queue files it under a heading that says it blocks nothing, and a red
 * banner one click away saying it blocks a workflow is the product
 * contradicting itself — which is exactly what this used to do for three of the
 * five positions it counted. Age keeps the surfaces it honestly owns: Zone A's
 * oldest-position line, the red navigation badge, and the rubric that names it.
 *
 * The two counts stay separate rather than summing into one predicate, because
 * no single verb is true of both: an expired position stopped nothing, it
 * lapsed.
 */
export interface BannerSubset {
  /** Stopped right now — the queue's own blocking rubric. */
  blocking: number;
  /** Deadline passed unanswered — the queue's own expired rubric. */
  overdue: number;
  /** blocking + overdue. The banner's whole claim, and nothing beyond it. */
  count: number;
  /** Every open position, so neither number is stated without its base. */
  total: number;
  /** The page holds fewer positions than the engine counted, so both numbers
   *  are floors and the wording has to say "at least". */
  atLeast: boolean;
  /** Whether §8.7 applies at all. */
  shown: boolean;
}

export function bannerSubset(open: OpenDecisions): BannerSubset {
  const blocking = open.subsets.blocking;
  const overdue = open.subsets.overdue;
  const count = blocking + overdue;
  return {
    blocking,
    overdue,
    count,
    total: open.total,
    atLeast: open.capped && count > 0,
    shown: count > 0 && open.total > 0,
  };
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
