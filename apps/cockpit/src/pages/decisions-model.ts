import type { Conversation } from "@/api/client";
import type { PatchCandidate, SkillCandidate } from "@/api/decisions";
import type { TranslationKey } from "@/lib/i18n";
import { computeLineDiff, type FocusedRow, focusDiff, toDiffLines } from "@/lib/line-diff";
import { clipAtWord, conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import {
  type ConversationEvidence,
  fixerKey,
  type PatchEvidence,
  type SkillEvidence,
} from "./decisions-context";

export type DecisionKind = "patch" | "skill" | "conversation";

export type DecisionOrigin =
  | "observedFailure"
  | "repairPattern"
  | "failurePattern"
  | "successPattern"
  | "authoringPattern"
  | "connectorPattern"
  | "sessionPattern"
  | "knowledgeLearning"
  | "chainedPattern"
  | "recurringPattern"
  | "conversation";

export type DecisionUrgency = "expired" | "expiring" | "blocking" | "deferred";

export interface DecisionItem {
  reviewable?: boolean;
  reviewDigest?: string | null;
  reviewReason?: string | null;
  kind: DecisionKind;
  id: string;
  title: string;
  target: string | null;
  origin: DecisionOrigin;
  waitingSince: string;
  classification: "safe" | "unsafe" | null;
  expiresAt: string | null;
  confidence: "low" | "medium" | "high" | null;
  evidenceCount: number | null;
  summary: string | null;
  detail: DecisionDetail;
}

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

export interface SkillSections {
  examples: string[];
  bestPractices: string[];
  pitfalls: string[];
  docRefs: string[];
  tags: string[];
}

export const AGED_AFTER_DAYS = 3;

export function ageInDays(waitingSince: string, now: number): number {
  const started = Date.parse(waitingSince);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 86_400_000));
}

export function patchChangeKind(candidate: PatchCandidate): {
  proposalKind: string | null;
  driftKind: string | null;
  fixer: string | null;
} {
  const envelope = readDiffEnvelope(candidate.diff);
  return {
    proposalKind: envelope.proposalKind,
    driftKind: envelope.driftKind,
    fixer: envelope.fixer,
  };
}

export interface PatchTitle {
  key: TranslationKey;
  params: Record<string, string>;
}

export function patchTitle(input: { workflow: string | null; change: string | null }): PatchTitle {
  const workflow = input.workflow?.trim() || null;
  const change = input.change?.trim() || null;
  if (workflow && change) return { key: "decisions.patchTitle", params: { workflow, change } };
  if (workflow) return { key: "decisions.patchTitleWorkflow", params: { workflow } };
  if (change) return { key: "decisions.patchTitleChange", params: { change } };
  return { key: "decisions.fallbackTitle.patch", params: {} };
}

export function isWholeQueue(view: {
  kinds: number;
  focus: string | null;
  workflowFilter: string | null;
}): boolean {
  return view.kinds === 0 && view.focus === null && view.workflowFilter === null;
}

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
    summary: fixerKey(envelope.fixer) ? null : (envelope.description?.trim() ?? null),
    detail: {
      kind: "patch",
      evidence: {
        workflowId: candidate.workflow_id ?? null,
        workflowName: candidate.workflow_name ?? null,
        connectorId: candidate.connector_id ?? null,
        endpointKey: candidate.endpoint_key ?? null,
        executionId: envelope.executionId,
        environment: envelope.environment,
        workflowStepId: envelope.workflowStepId,
        gateCode: envelope.gateCode,
        gateReason: envelope.gateReason,
        gateStepId: envelope.gateStepId,
        fixer: envelope.fixer,
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

const SKILL_ORIGIN: Record<string, DecisionOrigin> = {
  repair_pattern: "repairPattern",
  failure_pattern: "failurePattern",
  success_pattern: "successPattern",
  authoring_capability: "authoringPattern",
  connector_capability: "connectorPattern",
  session_learning: "sessionPattern",
  knowledge_learning: "knowledgeLearning",
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
    reviewReason: null,
    id: candidate.id,
    title: candidate.title,
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

export const QUESTION_LINE_MAX = 180;

export interface ConversationLabels {
  fallbackTitle: string;
  toolActivity: string;
  hiddenReference: string;
}

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

function firstParagraph(body: unknown): string | null {
  const text = str(body);
  if (!text) return null;
  const paragraph = text
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return paragraph && paragraph.length > 0 ? paragraph : null;
}

function readDiffEnvelope(diff: unknown): {
  description: string | null;
  reasoning: string | null;
  proposalKind: string | null;
  driftKind: string | null;
  driftSummary: string | null;
  executionId: string | null;
  environment: "dev" | "prod" | null;
  workflowStepId: string | null;
  gateCode: string | null;
  gateReason: string | null;
  gateStepId: string | null;
  fixer: string | null;
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
    environment: null,
    workflowStepId: null,
    gateCode: null,
    gateReason: null,
    gateStepId: null,
    fixer: null,
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
    environment:
      envelope.environment === "dev" || envelope.environment === "prod"
        ? envelope.environment
        : null,
    workflowStepId: str(envelope.workflow_step_id),
    gateCode: signal.kind === "gate_block" ? str(signal.code) : null,
    gateReason: signal.kind === "gate_block" ? str(signal.reason) : null,
    gateStepId: signal.kind === "gate_block" ? str(signal.step_id) : null,
    fixer: str(signal.fixer),
    classificationReasons: stringList(envelope.classification_reasons),
    rejections,
  };
}

export const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;

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
  expired: DecisionItem[];
  blocking: DecisionItem[];
  deferred: DecisionRubrics;
}

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

export function hasOverdue(items: readonly DecisionItem[], now: number): boolean {
  return items.some((item) => {
    const urgency = decisionUrgency(item, now);
    if (urgency === "expired" || urgency === "expiring") return true;
    return ageInDays(item.waitingSince, now) >= AGED_AFTER_DAYS;
  });
}

export interface DecisionTotals {
  patch: number;
  skill: number;
  conversation: number;
}

export interface OpenDecisionSubsets {
  blocking: number;
  overdue: number;
  aging: number;
}

export interface OpenDecisions {
  total: number;
  decidable: number;
  byKind: Record<DecisionKind, number>;
  subsets: OpenDecisionSubsets;
  oldestAgeDays: number;
  capped: boolean;
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

export interface BannerSubset {
  blocking: number;
  overdue: number;
  count: number;
  total: number;
  atLeast: boolean;
  shown: boolean;
}

export function bannerSubset(open: OpenDecisions): BannerSubset {
  const blocking = open.subsets.blocking;
  const overdue = open.subsets.overdue;
  const count = blocking + overdue;
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

export type QueueDisplayState = "rows" | "filtered-empty" | "empty";

export function queueDisplayState(input: {
  shown: number;
  held: number;
  failing: number;
  total: number;
  narrowed: boolean;
}): QueueDisplayState {
  if (input.shown > 0 || input.held > 0 || input.failing > 0) return "rows";
  return input.narrowed && input.total > 0 ? "filtered-empty" : "empty";
}

export type QueueKind = DecidableKind | "schedule";
export const QUEUE_KINDS: readonly QueueKind[] = ["patch", "skill", "schedule"];

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
  return {
    ...open,
    total: open.total + input.held + input.failing,
    subsets: { ...open.subsets, blocking: open.subsets.blocking + input.held + input.failing },
  };
}

export type SourceState = "answered" | "failed" | "not_permitted";

export interface QueueChip {
  kind: QueueKind;
  index: number;
  count: number | null;
  partial: boolean;
}

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

export interface ReadableSources {
  patches: boolean;
  skills: boolean;
  failing: boolean;
}

export function readableQueueKinds(readable: ReadableSources): QueueKind[] {
  return QUEUE_KINDS.filter((kind) =>
    kind === "patch"
      ? readable.patches
      : kind === "skill"
        ? readable.skills
        : readable.patches || readable.failing,
  );
}

export function badgeCount(chips: readonly QueueChip[] | null): number | null {
  if (!chips) return null;
  const total = chips.reduce((sum, chip) => sum + (chip.count ?? 0), 0);
  return total > 0 ? total : null;
}

export interface DecisionView {
  focus: "blocked" | "failing" | "overdue" | "other" | null;
  kinds: QueueKind[];
}

export function resetView(): DecisionView {
  return { focus: null, kinds: [] };
}

export function searchWithoutBucket(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("bucket");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

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

export function humanStep(stepKey: string): string {
  return stepKey.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export interface ChangeFact {
  path: string;
  inline: { before: string; after: string } | null;
  rows: FocusedRow[];
}

const CHANGE_FACT_LIMIT = 3;
const CHANGE_VALUE_LIMIT = 120;

function valueAt(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      source,
    );
}

function shownValue(value: unknown): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function fitsOnALine(text: string): boolean {
  return !text.includes("\n") && text.length <= CHANGE_VALUE_LIMIT;
}

function focusedRows(before: unknown, after: unknown): FocusedRow[] {
  return focusDiff(computeLineDiff(toDiffLines(before), toDiffLines(after)));
}

function changeFact(path: string, before: unknown, after: unknown): ChangeFact {
  const shownBefore = shownValue(before);
  const shownAfter = shownValue(after);
  return fitsOnALine(shownBefore) && fitsOnALine(shownAfter)
    ? { path, inline: { before: shownBefore, after: shownAfter }, rows: [] }
    : { path, inline: null, rows: focusedRows(before, after) };
}

export function changeRows(facts: readonly ChangeFact[]): FocusedRow[] {
  return facts.flatMap((fact): FocusedRow[] =>
    fact.inline
      ? [
          { type: "removed", text: fact.inline.before },
          { type: "added", text: fact.inline.after },
        ]
      : fact.rows,
  );
}

export function changeFacts(
  before: unknown,
  after: unknown,
  paths: readonly string[] | null | undefined,
): ChangeFact[] {
  const listed = (paths ?? []).slice(0, CHANGE_FACT_LIMIT);
  if (listed.length === 0) {
    const rows = focusedRows(before, after);
    return rows.length > 0 ? [{ path: "", inline: null, rows }] : [];
  }
  return listed.map((path) => changeFact(path, valueAt(before, path), valueAt(after, path)));
}
