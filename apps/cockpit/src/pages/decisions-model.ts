import type { Conversation } from "@/api/client";
import type { PatchCandidate, SkillCandidate } from "@/api/decisions";
import type { TranslationKey } from "@/lib/i18n";
import { clipAtWord, conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import type { ConversationEvidence, PatchEvidence, SkillEvidence } from "./decisions-context";

export type DecisionKind = "patch" | "skill" | "conversation";

/** Where a position came from — the sentence that answers "why am I seeing this". */
export type DecisionOrigin =
  | "observedFailure"
  | "repairPattern"
  | "failurePattern"
  | "successPattern"
  | "authoringPattern"
  | "connectorPattern"
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
  reviewable?: boolean;
  reviewDigest?: string | null;
  reviewReason?: string | null;
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
export type PatchDetail = { kind: "patch"; evidence: PatchEvidence };
export type SkillDetail = {
  kind: "skill";
  evidence: SkillEvidence;
  body: string;
  sections: SkillSections;
};
export type ConversationDetail = {
  kind: "conversation";
  evidence: ConversationEvidence;
  question: string | null;
  tool: string | null;
};

export type DecisionDetail = PatchDetail | SkillDetail | ConversationDetail;

/**
 * A position this page can actually decide.
 *
 * A waiting conversation is not one. It carries no approve and no reject here —
 * the card's only action was ever a link into the chat — so the queue was
 * asking a person to work through positions it could not act on. §8.5b: what
 * has no consequence here is not a decision here. It is counted, named and
 * pointed at, on the tile above.
 *
 * This comment used to put a size on it — "32 of 35 on the day this was
 * measured". That 32 came from the test bench's mock, which ignored the status
 * filter; on PROD the same call answers total=1. The rule never depended on the
 * number, so the number is gone and the rule stands (§8.5b's correction block).
 */
export type DecidableKind = Exclude<DecisionKind, "conversation">;

export type DecidableItem = Omit<DecisionItem, "kind" | "detail"> & {
  kind: DecidableKind;
  detail: PatchDetail | SkillDetail;
};

export function isDecidable(item: DecisionItem): item is DecidableItem {
  return (
    item.kind !== "conversation" && item.detail.kind !== "conversation" && item.reviewable !== false
  );
}

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

/** Whether the queue is unnarrowed — no kind chip, no tile focus, no workflow from a link. */
export function isWholeQueue(view: {
  kinds: number;
  focus: string | null;
  workflowFilter: string | null;
}): boolean {
  return view.kinds === 0 && view.focus === null && view.workflowFilter === null;
}

/** The workflow a decision acts on, where the decision knows it. */
export function decisionWorkflowId(item: DecisionItem): string | null {
  const detail = item.detail;
  return detail.kind === "patch" || detail.kind === "skill" ? detail.evidence.workflowId : null;
}

export function patchDecision(candidate: PatchCandidate, title: string): DecisionItem {
  const envelope = readDiffEnvelope(candidate.diff);
  return {
    kind: "patch",
    reviewable: candidate.reviewable === true,
    reviewDigest: candidate.review_digest,
    reviewReason: candidate.review_reason,
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
  connector_capability: "connectorPattern",
  session_learning: "sessionPattern",
  chained_workflow_pattern: "chainedPattern",
};

export function skillDecision(
  candidate: SkillCandidate,
  targetName: string | null = null,
): DecisionItem {
  return {
    kind: "skill",
    reviewable: candidate.reviewable === true,
    reviewDigest: candidate.review_digest,
    reviewReason: candidate.reviewable ? null : "advisory",
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
  /**
   * The subset the queue below the tiles actually holds.
   *
   * `total` counts everything waiting on this person; `decidable` counts what
   * can be approved or rejected here. The two were the same number for as long
   * as waiting conversations were rendered as cards nobody could act on, which
   * is how a queue of three grew to thirty-five.
   */
  decidable: number;
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
 * `stuck` flag, Zone A read the digest's patch-candidate count, and the
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
          if (item.kind === "conversation" || item.reviewable !== false) counts[item.kind] += 1;
          return counts;
        },
        { patch: 0, skill: 0, conversation: 0 } as DecisionTotals,
      );
  const total = counted.patch + counted.skill;
  const subsets: OpenDecisionSubsets = { blocking: 0, overdue: 0, aging: 0 };
  let oldestAgeDays = 0;
  for (const item of unique) {
    if (item.kind !== "conversation" && !isDecidable(item)) continue;
    const urgency = decisionUrgency(item, input.nowMs);
    const age = ageInDays(item.waitingSince, input.nowMs);
    if (isDecidable(item) && age > oldestAgeDays) oldestAgeDays = age;
    if (urgency === "expired") subsets.overdue += 1;
    else if (urgency === "blocking" || urgency === "expiring") subsets.blocking += 1;
    else if (age >= AGED_AFTER_DAYS) subsets.aging += 1;
  }
  return {
    total,
    decidable: counted.patch + counted.skill,
    byKind: { patch: counted.patch, skill: counted.skill, conversation: counted.conversation },
    subsets,
    oldestAgeDays,
    capped: unique.filter(isDecidable).length < total,
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
  // The base is the conversations, not the whole page. Both states the banner
  // may claim belong to a waiting conversation and to nothing else: only an
  // elicitation carries a deadline, and only a suspended agent loop is stopped
  // dead. Stating them as a share of every open position made the two numbers
  // unreadable — "2 of 35" invited the reader to look for the other 33 in a
  // queue that never held them.
  const total = open.byKind.conversation;
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
  if (kinds.length === 0) return [...items];
  return items.filter((item) => kinds.includes(item.kind));
}

/**
 * Which of the three things the queue should show: its rows, "nothing matches
 * your filter", or "nothing is waiting".
 *
 * A predicate rather than a nested ternary in the page, because the page got it
 * wrong in a way nobody could see in the markup: the guard was written when the
 * queue had held schedules and decidable items, and the failing-workflows
 * section was added beside it without being counted. So on
 * `/cockpit/decisions?bucket=failing` the page rendered a failing card, a count
 * of 1, AND "all done — nothing is waiting for you", all at once. Three
 * statements, two of them contradicting the third.
 *
 * The rule, once: the queue is empty only when it is showing nothing at all.
 */
export type QueueDisplayState = "rows" | "filtered-empty" | "empty";

export function queueDisplayState(input: {
  /** Decidable rows after the reader's own chips. */
  shown: number;
  /** Held schedules currently rendered. */
  held: number;
  /** Failing workflows currently rendered. */
  failing: number;
  /** Everything the queue holds, before the chips. */
  total: number;
  /** The reader narrowed it themselves. */
  narrowed: boolean;
}): QueueDisplayState {
  if (input.shown > 0 || input.held > 0 || input.failing > 0) return "rows";
  // Nothing on screen. Whether that is "your filter matches nothing" or
  // "nothing is waiting" depends on whether anything exists to be narrowed
  // away — and `total` must include every section, or a narrowed-away failing
  // workflow reads as an empty queue.
  return input.narrowed && input.total > 0 ? "filtered-empty" : "empty";
}

/** The three kind chips. `schedule` holds both held and failing scheduled workflows. */
export type QueueKind = DecidableKind | "schedule";
export const QUEUE_KINDS: readonly QueueKind[] = ["patch", "skill", "schedule"];

/**
 * The count behind the navigation badge, and the rule it keeps.
 *
 * One rule: **the badge counts what the chips count** — proposed repairs,
 * proposed skills, and the scheduled workflows that are held or keep failing.
 * The waiting conversations ("Rückfragen") are not in it. They carry no
 * approve and no reject on this page (§8.5b: what has no consequence here is
 * not a decision here); they are counted on their own tab and answered in the
 * chat. Before this rule the badge folded the schedules in by hand after the
 * count was taken, and no chip said where those extra positions were.
 */
export function openDecisionQueue(input: {
  items: readonly DecisionItem[];
  totals: DecisionTotals | null;
  held: number;
  failing: number;
  nowMs: number;
}): OpenDecisions {
  const open = countOpenDecisions({
    items: input.items,
    totals: input.totals,
    nowMs: input.nowMs,
  });
  // A workflow that runs and fails is as open a decision as one that cannot
  // start, and a badge that leaves it out was the reason nobody looked.
  return {
    ...open,
    total: open.total + input.held + input.failing,
    subsets: { ...open.subsets, blocking: open.subsets.blocking + input.held + input.failing },
  };
}

/**
 * Whether a source was asked and answered. `not_permitted`: this person may
 * not read it, so it was never asked — which is not the same as "nothing".
 */
export type SourceState = "answered" | "failed" | "not_permitted";

/** One kind chip as the page shows it. */
export interface QueueChip {
  kind: QueueKind;
  /** Position in QUEUE_KINDS — the chip's test id stays put when another is hidden. */
  index: number;
  /** The number, or null when no source behind this chip answered. Never a guessed 0. */
  count: number | null;
  /** True when one of the chip's sources failed and the number is a lower bound. */
  partial: boolean;
}

/**
 * The kind chips, from the same count as the badge — and only the ones this
 * person can read.
 *
 * The chips carry the engine's exact per-kind totals (`reviewable_total`), so
 * their sum IS the badge; a chip reading from the rows the page holds would be
 * a second count. Two ways a chip used to say "0" about something nobody had
 * measured: a source this person may not read (`skill:read`, `workflow:read`)
 * still got its chip, at "· 0"; and a digest that failed to load was caught as
 * an empty list, so the failing workflows read as none. A source that cannot
 * be read has no chip. A source that failed contributes nothing to any number
 * and says so — a count it is part of becomes "at least", and a chip with no
 * other source says it could not be loaded.
 *
 * `null` while the count cannot be read at all: an omitted number beats a
 * guessed one.
 */
export function queueChips(input: {
  open: OpenDecisions | null;
  readable: ReadableSources;
  held: number;
  failing: { state: SourceState; count: number };
}): QueueChip[] | null {
  const open = input.open;
  if (!open) return null;
  const failed = input.failing.state === "failed";
  return readableQueueKinds(input.readable).map((kind) => {
    const index = QUEUE_KINDS.indexOf(kind);
    if (kind !== "schedule") return { kind, index, count: open.byKind[kind], partial: false };
    // Held schedules are read with the patch source (`workflow:read`); failing
    // workflows come from the digest (`stats:read`). The chip covers both.
    const held = input.readable.patches ? input.held : 0;
    const failing = input.failing.state === "answered" ? input.failing.count : 0;
    return {
      kind,
      index,
      count: failed && !input.readable.patches ? null : held + failing,
      partial: failed && input.readable.patches,
    };
  });
}

/** Which sources this person may read — the permission, not the answer. */
export interface ReadableSources {
  patches: boolean;
  skills: boolean;
  failing: boolean;
}

/** The kinds with a chip: those with at least one source this person can read. */
export function readableQueueKinds(readable: ReadableSources): QueueKind[] {
  return QUEUE_KINDS.filter((kind) =>
    kind === "patch"
      ? readable.patches
      : kind === "skill"
        ? readable.skills
        : readable.patches || readable.failing,
  );
}

/**
 * The navigation badge: the sum of the numbers the chips show, nothing else.
 * `null` when there is no number to show — never a 0 claimed over a source
 * that failed (the page says that source failed; the badge counts what answered).
 */
export function badgeCount(chips: readonly QueueChip[] | null): number | null {
  if (!chips) return null;
  const total = chips.reduce((sum, chip) => sum + (chip.count ?? 0), 0);
  return total > 0 ? total : null;
}

/** Where the reader arrived from (an overview tile) and what they chose here (chips). */
export interface DecisionView {
  focus: "blocked" | "failing" | "overdue" | "other" | null;
  kinds: QueueKind[];
}

/**
 * Back to the whole queue — the ONE way, for every "show all" on the page.
 *
 * "Alle anzeigen" under a filtered-empty queue cleared only the chips, so a
 * reader who arrived from a tile and found nothing there pressed it and got
 * the same empty, narrowed list back: a dead end labelled as the way out.
 */
export function resetView(): DecisionView {
  return { focus: null, kinds: [] };
}

/**
 * The address without the tile's narrowing, and with everything else kept.
 *
 * Only `bucket` is the tile's; any other parameter (a workflow the reader was
 * sent about, say) is not this reset's to drop.
 */
export function searchWithoutBucket(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("bucket");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * Why "Freigeben" cannot be pressed, said where the button is.
 *
 * A greyed-out button with no reason is a question the reader cannot answer:
 * they could not tell "look at the change first" from "your role may not do
 * this" from "this change cannot be approved as it stands". `null` while
 * nothing blocks it, or while the block is momentary (a decision in flight, a
 * preview still loading, the reject note open).
 */
export function approveBlockedReason(input: {
  canDecide: boolean;
  expanded: boolean;
  kind: DecidableKind;
  reviewDigest: string | null | undefined;
  preview: { reviewable?: boolean | null; review_digest?: string | null } | undefined;
}): TranslationKey | null {
  if (!input.canDecide) return "decisions.approveNeedsRole";
  if (!input.expanded) return "decisions.approveNeedsReview";
  if (input.kind === "skill") return input.reviewDigest ? null : "decisions.approveNotReviewable";
  if (!input.preview) return null;
  return input.preview.reviewable && input.preview.review_digest
    ? null
    : "decisions.approveNotReviewable";
}

/**
 * The positions under "Vorschläge und Hinweise", each with somewhere to go.
 *
 * These cannot be decided here (§8.5b), so an item earns its place only by
 * leading to where it can be acted on: its workflow. One with no workflow has
 * nowhere to lead and is left out rather than shown as a dead card.
 */
export function suggestionTargets(
  items: readonly DecisionItem[],
): Array<{ item: DecisionItem; workflowId: string }> {
  const out: Array<{ item: DecisionItem; workflowId: string }> = [];
  for (const item of items) {
    if (item.kind === "conversation" || isDecidable(item)) continue;
    const detail = item.detail;
    const workflowId =
      detail.kind === "patch" || detail.kind === "skill" ? detail.evidence.workflowId : null;
    if (workflowId) out.push({ item, workflowId });
  }
  return out;
}

/**
 * A step key as a person reads it: `fetch_orders` → "fetch orders".
 *
 * The failing card named the raw key. Keys are written for the engine, with
 * underscores and hyphens a reader has to decode.
 */
export function humanStep(stepKey: string): string {
  return stepKey.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
