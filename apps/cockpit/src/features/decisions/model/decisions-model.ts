import type { Conversation } from "@/api/client";
import type { PatchCandidate, SkillCandidate } from "@/api/decisions";
import type { TranslationKey } from "@/lib/i18n";
import type { FocusedRow } from "@/lib/line-diff";
import { clipAtWord, conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import {
  approveBlockedReason as coreApproveBlockedReason,
  patchChangeKind as corePatchChangeKind,
} from "./decision-facts";
import {
  ageInDays,
  countOpenDecisions as coreCountOpenDecisions,
  openDecisionQueue as coreOpenDecisionQueue,
  queueChips as coreQueueChips,
  queueDisplayState as coreQueueDisplayState,
} from "./decision-queue";
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

type DecisionUrgency = "expired" | "expiring" | "blocking" | "deferred";

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
export type ConversationDecisionDetail = {
  kind: "conversation";
  evidence: ConversationEvidence;
  question: string | null;
  tool: string | null;
};

export type DecisionDetail = PatchDetail | SkillDetail | ConversationDecisionDetail;

export type DecidableKind = Exclude<DecisionKind, "conversation">;

export const ORIGIN_LABEL: Record<DecisionOrigin, TranslationKey> = {
  observedFailure: "decisions.origin.observedFailure",
  repairPattern: "decisions.origin.repairPattern",
  failurePattern: "decisions.origin.failurePattern",
  successPattern: "decisions.origin.successPattern",
  authoringPattern: "decisions.origin.authoringPattern",
  connectorPattern: "decisions.origin.connectorPattern",
  sessionPattern: "decisions.origin.sessionPattern",
  knowledgeLearning: "decisions.origin.knowledgeLearning",
  chainedPattern: "decisions.origin.chainedPattern",
  recurringPattern: "decisions.origin.recurringPattern",
  conversation: "decisions.origin.conversation",
};

interface DecisionAction {
  kind: "apply" | "reject" | "open";
  labelKey: TranslationKey;
}

export function decisionActions(kind: DecidableKind): DecisionAction[] {
  return kind === "patch"
    ? [
        { kind: "apply", labelKey: "decisions.applyFix" },
        { kind: "reject", labelKey: "decisions.reject" },
      ]
    : [{ kind: "open", labelKey: "decisions.reviewSkill" }];
}

export type DecidableItem = Omit<DecisionItem, "kind" | "detail"> & {
  kind: DecidableKind;
  detail: PatchDetail | SkillDetail;
};

export function isDecidable(item: DecisionItem): item is DecidableItem {
  return (
    item.kind !== "conversation" && item.detail.kind !== "conversation" && item.reviewable !== false
  );
}

interface SkillSections {
  examples: string[];
  bestPractices: string[];
  pitfalls: string[];
  docRefs: string[];
  tags: string[];
}

const AGED_AFTER_DAYS = 3;

export function patchChangeKind(candidate: PatchCandidate): {
  proposalKind: string | null;
  driftKind: string | null;
  fixer: string | null;
} {
  return corePatchChangeKind(candidate);
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

interface ConversationLabels {
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

const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;

function decisionUrgency(item: DecisionItem, now: number): DecisionUrgency {
  if (item.expiresAt) {
    const expires = Date.parse(item.expiresAt);
    if (!Number.isNaN(expires)) {
      if (expires <= now) return "expired";
      if (expires - now <= EXPIRING_WITHIN_MS) return "expiring";
    }
  }
  return item.kind === "conversation" ? "blocking" : "deferred";
}

export function hasOverdue(items: readonly DecisionItem[], now: number): boolean {
  return items.some((item) => {
    const urgency = decisionUrgency(item, now);
    if (urgency === "expired" || urgency === "expiring") return true;
    return ageInDays(item.waitingSince, now) >= AGED_AFTER_DAYS;
  });
}

interface DecisionTotals {
  patch: number;
  skill: number;
  conversation: number;
}

interface OpenDecisionSubsets {
  blocking: number;
  overdue: number;
  aging: number;
}

interface OpenDecisions {
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
  return coreCountOpenDecisions(input);
}

type QueueDisplayState = "rows" | "filtered-empty" | "empty";

export function queueDisplayState(input: {
  shown: number;
  held: number;
  failing: number;
  total: number;
  narrowed: boolean;
}): QueueDisplayState {
  return coreQueueDisplayState(input);
}

type QueueKind = DecidableKind | "schedule";

export function openDecisionQueue(input: {
  items: readonly DecisionItem[];
  totals: DecisionTotals | null;
  held: number;
  failing: number;
  nowMs: number;
}): OpenDecisions {
  return coreOpenDecisionQueue(input);
}

export type SourceState = "answered" | "failed" | "not_permitted";

interface QueueChip {
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
  return coreQueueChips(input);
}

interface ReadableSources {
  patches: boolean;
  skills: boolean;
  failing: boolean;
}

interface DecisionView {
  focus: "blocked" | "failing" | "overdue" | "other" | null;
  kinds: QueueKind[];
}

export function resetView(): DecisionView {
  return { focus: null, kinds: [] };
}

export function approveBlockedReason(input: {
  canDecide: boolean;
  expanded: boolean;
  kind: DecidableKind;
  reviewDigest: string | null | undefined;
  preview: { reviewable?: boolean | null; review_digest?: string | null } | undefined;
}): TranslationKey | null {
  return coreApproveBlockedReason(input);
}

export interface ChangeFact {
  path: string;
  inline: { before: string; after: string } | null;
  rows: FocusedRow[];
}
