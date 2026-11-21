import { connectorHref, conversationHref, runHref, workflowHref } from "@/app/links";
import type { Relation } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import type { NameIndex } from "@/lib/name-index";
import { resolveTargetName } from "@/lib/name-index";

export interface ContextEntry extends Relation {
  note?: string | null;
  noteKey?: TranslationKey;
}

export interface DecisionContext {
  sources: ContextEntry[];
  targets: ContextEntry[];
}

function href(
  kind: "workflow" | "connector" | "conversation" | "run",
  id: string | null,
): string | null {
  if (!id) return null;
  if (kind === "workflow") return workflowHref(id);
  if (kind === "connector") return connectorHref(id);
  if (kind === "conversation") return conversationHref(id);
  return runHref(id);
}

export interface PatchEvidence {
  workflowId: string | null;
  workflowName: string | null;
  connectorId: string | null;
  endpointKey: string | null;
  executionId: string | null;
  environment: "dev" | "prod" | null;
  workflowStepId: string | null;
  gateCode: string | null;
  gateReason: string | null;
  gateStepId: string | null;
  fixer: string | null;
  driftKind: string | null;
  driftSummary: string | null;
  reasoning: string | null;
  proposalKind: string | null;
  classificationReasons: string[];
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

const FIXER_LABEL: Record<string, TranslationKey> = {
  use_utf8_encoder: "decisions.fixer.useUtf8Encoder",
  declare_report_delivery: "decisions.fixer.declareReportDelivery",
};

const CLASSIFICATION_REASON_LABEL: Record<string, TranslationKey> = {
  gate_repair_requires_review: "decisions.classificationReason.gateRepairRequiresReview",
};

export function fixerKey(fixer: string | null): TranslationKey | null {
  return fixer ? (FIXER_LABEL[fixer] ?? null) : null;
}

export function classificationReasonKey(reason: string): TranslationKey | null {
  return CLASSIFICATION_REASON_LABEL[reason] ?? null;
}

export function driftKindKey(kind: string | null): TranslationKey | null {
  return kind ? (DRIFT_KIND_LABEL[kind] ?? null) : null;
}

export function proposalKindKey(kind: string | null): TranslationKey | null {
  return kind ? (PROPOSAL_KIND_LABEL[kind] ?? null) : null;
}

export interface ContextLabels {
  cause: string | null;
  causeFallback: string;
  failedRun: string;
  endpoint: string;
  workflow: string;
  conversation: string;
  allWorkflows: string;
  noTarget: string;
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
  if (evidence.executionId && canReadRuns) {
    sources.push({ href: href("run", evidence.executionId), label: labels.failedRun });
  }
  if (evidence.endpointKey && evidence.driftKind !== "gate_block") {
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
