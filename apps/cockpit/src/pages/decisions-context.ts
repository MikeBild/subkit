import { connectorHref, conversationHref, runHref, workflowHref } from "@/app/links";
import type { Relation } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import type { NameIndex } from "@/lib/name-index";
import { resolveTargetName } from "@/lib/name-index";

// Where a decision came from, and what it touches.
//
// The queue could say a fix was waiting but not what failed, not which endpoint
// moved, not which run produced it — and every one of those facts was already in
// the list response, thrown away at the mapping layer. A person was asked to
// approve or reject with the evidence sitting one field away.
//
// Both columns are lists of `Relation` (`href: string | null`). An id we hold is
// always a valid route, so it always becomes a link — what degrades when the
// catalogue cannot name the thing is the LABEL, which falls back to the word for
// its kind. That keeps ids off the screen without throwing away a working
// destination: "Konnektor · GET /reports" leads somewhere, "Ohne festes Ziel"
// would have been a lie about a target that exists.

/** A labelled row in one of the two context columns. */
export interface ContextEntry extends Relation {
  /** Short qualifier rendered beside the label — an endpoint, a change kind. */
  note?: string | null;
  /** Translation key for the qualifier, when it is a fixed word rather than data. */
  noteKey?: TranslationKey;
}

export interface DecisionContext {
  /** What produced this position. */
  sources: ContextEntry[];
  /** What a decision would act on. */
  targets: ContextEntry[];
}

/** The one place a cockpit route is derived from a domain id. */
function href(
  kind: "workflow" | "connector" | "conversation" | "run",
  id: string | null,
): string | null {
  if (!id) return null;
  if (kind === "workflow") return workflowHref(id);
  if (kind === "connector") return connectorHref(id);
  if (kind === "conversation") return conversationHref(id);
  // A run has its own address now. This said "runs have no detail route; the
  // list is the honest destination", which was true when written and is the
  // reason the route was built: a decision that names the run which failed
  // could point at the list and no further. It points at the run.
  return runHref(id);
}

/** The shape `patchDecision` reads out of a candidate's `diff` blob. */
export interface PatchEvidence {
  workflowId: string | null;
  workflowName: string | null;
  connectorId: string | null;
  endpointKey: string | null;
  executionId: string | null;
  /** The drift kind, as the engine named it. */
  driftKind: string | null;
  /** The engine's rendered explanation of the drift. */
  driftSummary: string | null;
  /** The model's stated justification for the proposal. */
  reasoning: string | null;
  /** What class of change this is. */
  proposalKind: string | null;
  /** Why the classifier called it safe or unsafe. */
  classificationReasons: string[];
  /** Earlier attempts the repair loop rejected, and why. */
  rejections: string[];
}

const DRIFT_KIND_LABEL: Record<string, TranslationKey> = {
  http_status_new_shape: "decisions.drift.httpStatusNewShape",
  jsonata_path_miss: "decisions.drift.pathMiss",
  schema_diff: "decisions.drift.schemaDiff",
  stdlib_version_drift: "decisions.drift.stdlibVersion",
  validation_failed: "decisions.drift.validationFailed",
  endpoint_contract: "decisions.drift.endpointContract",
  gate_block: "decisions.drift.gateBlock",
};

const PROPOSAL_KIND_LABEL: Record<string, TranslationKey> = {
  update_field_path: "decisions.change.updateFieldPath",
  rename_param: "decisions.change.renameParam",
  change_type: "decisions.change.changeType",
  add_header: "decisions.change.addHeader",
  rate_limited: "decisions.change.rateLimited",
  other: "decisions.change.other",
  gate_fix: "decisions.change.gateFix",
};

/** The word for a drift kind, or null when the engine sent one we do not know. */
export function driftKindKey(kind: string | null): TranslationKey | null {
  return kind ? (DRIFT_KIND_LABEL[kind] ?? null) : null;
}

/** The word for a proposal kind, or null for an unknown one. */
export function proposalKindKey(kind: string | null): TranslationKey | null {
  return kind ? (PROPOSAL_KIND_LABEL[kind] ?? null) : null;
}

export interface ContextLabels {
  /** Already-translated word for the drift that caused this, or null. */
  cause: string | null;
  /** Already-translated fallback when no cause is known. */
  causeFallback: string;
  failedRun: string;
  /** Already-translated word for a connector nobody could name. */
  endpoint: string;
  /** Already-translated word for a workflow nobody could name. */
  workflow: string;
  conversation: string;
  allWorkflows: string;
  noTarget: string;
  /** Already-translated word for the pattern a skill was distilled from. */
  pattern: string;
  observedCases: string;
}

export function patchContext(
  evidence: PatchEvidence,
  labels: ContextLabels,
  index: NameIndex,
  canReadRuns: boolean,
): DecisionContext {
  const sources: ContextEntry[] = [{ href: null, label: labels.cause ?? labels.causeFallback }];
  // A run the person cannot open is worse than no link: the permission is
  // additionally evaluated per object, so a link would resolve to a refusal.
  if (evidence.executionId && canReadRuns) {
    sources.push({ href: href("run", evidence.executionId), label: labels.failedRun });
  }
  if (evidence.endpointKey) {
    sources.push({
      href: href("connector", evidence.connectorId),
      label: resolveTargetName(index, "connector", evidence.connectorId) ?? labels.endpoint,
      note: evidence.endpointKey,
    });
  }

  const workflowName =
    evidence.workflowName ?? resolveTargetName(index, "workflow", evidence.workflowId);
  const targets: ContextEntry[] = workflowName
    ? [{ href: href("workflow", evidence.workflowId), label: workflowName }]
    : [];
  return { sources, targets };
}

export interface SkillEvidence {
  scope: string;
  workflowId: string | null;
  connectorId: string | null;
  endpointKey: string | null;
  evidenceCount: number | null;
}

export function skillContext(
  evidence: SkillEvidence,
  labels: ContextLabels,
  index: NameIndex,
): DecisionContext {
  const sources: ContextEntry[] = [{ href: null, label: labels.pattern }];
  if (typeof evidence.evidenceCount === "number" && evidence.evidenceCount > 0) {
    sources.push({ href: null, label: labels.observedCases });
  }

  const targets: ContextEntry[] = [];
  if (evidence.scope === "workflow") {
    // Scoped to a workflow we cannot name is still scoped to a workflow: the
    // link survives, only the label falls back.
    targets.push({
      href: href("workflow", evidence.workflowId),
      label: resolveTargetName(index, "workflow", evidence.workflowId) ?? labels.workflow,
    });
  } else if (evidence.scope === "connector") {
    targets.push({
      href: href("connector", evidence.connectorId),
      label: resolveTargetName(index, "connector", evidence.connectorId) ?? labels.endpoint,
      ...(evidence.endpointKey ? { note: evidence.endpointKey } : {}),
    });
  } else {
    // A global skill has no target and says so — that is a fact, not a gap.
    targets.push({ href: null, label: labels.allWorkflows });
  }
  return { sources, targets };
}

export interface ConversationEvidence {
  conversationId: string;
  targetWorkflowId: string | null;
  targetConnectorId: string | null;
}

export function conversationContext(
  evidence: ConversationEvidence,
  labels: ContextLabels,
  index: NameIndex,
): DecisionContext {
  const sources: ContextEntry[] = [
    { href: href("conversation", evidence.conversationId), label: labels.conversation },
  ];

  const workflowName = resolveTargetName(index, "workflow", evidence.targetWorkflowId);
  const connectorName = resolveTargetName(index, "connector", evidence.targetConnectorId);
  const targets: ContextEntry[] = [];
  if (workflowName) {
    targets.push({ href: href("workflow", evidence.targetWorkflowId), label: workflowName });
  }
  if (connectorName) {
    targets.push({ href: href("connector", evidence.targetConnectorId), label: connectorName });
  }
  if (targets.length === 0) targets.push({ href: null, label: labels.noTarget });
  return { sources, targets };
}
