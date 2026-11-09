import {
  classifyPersistedFailure,
  classifyRunFailure,
  humanizeClassification,
  type PreviewClassification,
} from "../../execution/core/classify.ts";
import { pickStoppingStep } from "../../execution/core/outcome.ts";
import type { RiskSignal } from "../risk-signals.ts";
import type { AttentionItem, AttentionV1 } from "./attention.ts";

export type FailureOrigin = "authoring" | "manual" | "scheduled" | "mixed";

export interface DigestFailureGroup {
  signature: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  error_code: string | null;
  origin: FailureOrigin;
  count: number;
  scheduled_count: number;
  last_seen: string;
  first_seen: string;
  latest_execution_id: string;
  connector_id: string | null;
  resolved_at: string | null;
  cause: string;
  cause_class: PreviewClassification;
  guidance: string | null;
}

export interface DigestPatch {
  id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  classification: "safe" | "unsafe";
  age_days: number;
  stuck: boolean;
  summary: string;
}

export interface OperatorHealthDigest {
  generated_at: string;
  window_hours: number;
  headline: string;
  failure_groups: DigestFailureGroup[];
  patch_candidates: { open: number; items: DigestPatch[] };
  risk: RiskSignal[];
  attention: AttentionV1;
  rendered: string;
  all_clear: boolean;
}

function originOf(row: { source_kind: string; request_source: string }): FailureOrigin {
  if (row.source_kind === "draft" || row.source_kind === "step") return "authoring";
  if (row.request_source === "scheduler") return "scheduled";
  return "manual";
}

function mergeOrigin(a: FailureOrigin, b: FailureOrigin): FailureOrigin {
  return a === b ? a : "mixed";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function stepConnectorId(requestMeta: unknown): string | null {
  const id = asRecord(asRecord(requestMeta).connector).connector_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface FailedExecutionFact {
  readonly id: string;
  readonly workflow_id: string | null;
  readonly source_kind: string;
  readonly source_ref: unknown;
  readonly request_source: string;
  readonly created_at: Date;
  readonly status: string;
  readonly failure: Readonly<{
    step_id?: string | null;
    error_code?: string | null;
    error_message?: string | null;
  }> | null;
}
export interface FailedStepFact {
  readonly execution_id: string;
  readonly step_key: string;
  readonly status: string;
  readonly error: unknown;
  readonly started_at: Date | null;
  readonly request_meta: unknown;
}

export function groupFailureFacts(
  failedExecs: readonly FailedExecutionFact[],
  failedSteps: readonly FailedStepFact[],
): Map<string, DigestFailureGroup> {
  const rowsByExec = new Map<string, (typeof failedSteps)[number][]>();
  for (const s of failedSteps) {
    const list = rowsByExec.get(s.execution_id) ?? [];
    list.push(s);
    rowsByExec.set(s.execution_id, list);
  }
  const stepByExec = new Map<string, (typeof failedSteps)[number]>();
  for (const exec of failedExecs) {
    const stopping = pickStoppingStep(rowsByExec.get(exec.id) ?? [], exec.failure?.step_id);
    if (stopping) stepByExec.set(exec.id, stopping);
  }

  const groups = new Map<string, DigestFailureGroup>();
  for (const exec of failedExecs) {
    const step = stepByExec.get(exec.id);
    const classified =
      classifyRunFailure(exec, step ?? null) ??
      classifyPersistedFailure({ status: exec.status, error: null });
    const errorCode = classified.error_code;
    const message = classified.message;
    const guidance = classified.guidance;
    const stepKey = step?.step_key ?? null;
    const wfKey = exec.workflow_id ?? `${exec.source_kind}`;
    const signature = `${wfKey}:${stepKey ?? "-"}:${errorCode ?? "-"}`;
    const origin = originOf(exec);
    const lastSeen = exec.created_at.toISOString();

    const existing = groups.get(signature);
    if (existing) {
      existing.count += 1;
      if (origin === "scheduled") existing.scheduled_count += 1;
      existing.origin = mergeOrigin(existing.origin, origin);
      if (lastSeen > existing.last_seen) existing.last_seen = lastSeen;
      if (lastSeen < existing.first_seen) existing.first_seen = lastSeen;
      continue;
    }

    const cause =
      guidance ??
      humanizeClassification(classified.classification, message, step?.status ?? "step");

    groups.set(signature, {
      signature,
      workflow_id: exec.workflow_id ?? null,
      workflow_name:
        exec.workflow_id === null ? ((asRecord(exec.source_ref).name as string) ?? null) : null,
      step_key: stepKey,
      error_code: errorCode,
      origin,
      count: 1,
      scheduled_count: origin === "scheduled" ? 1 : 0,
      last_seen: lastSeen,
      first_seen: lastSeen,
      latest_execution_id: exec.id,
      connector_id: stepConnectorId(step?.request_meta),
      resolved_at: null,
      cause,
      cause_class: classified.classification,
      guidance,
    });
  }

  return groups;
}

export function failingScheduledGroups(
  groups: readonly DigestFailureGroup[],
): DigestFailureGroup[] {
  return groups.filter((group) => group.scheduled_count > 0 && group.resolved_at === null);
}

const CLASS_WORD: Record<AttentionItem["class"], string> = {
  stopped: "stopped",
  failing: "failing",
  decide: "to decide",
};

export function attentionHeadline(attention: AttentionV1): string {
  const failed = Object.entries(attention.sources)
    .filter(([, state]) => state === "failed")
    .map(([source]) => source);
  const unread = failed.length > 0 ? ` Could not read: ${failed.join(", ")}.` : "";
  if (attention.items.length === 0) {
    return failed.length > 0
      ? `Nothing needs your attention in what could be read.${unread}`
      : "All clear — nothing needs your attention.";
  }
  const byClass = (["stopped", "failing", "decide"] as const)
    .map((klass) => [klass, attention.items.filter((item) => item.class === klass).length] as const)
    .filter(([, n]) => n > 0)
    .map(([klass, n]) => `${n} ${CLASS_WORD[klass]}`);
  const n = attention.items.length;
  return `Needs attention: ${n} item${n === 1 ? "" : "s"} (${byClass.join(", ")}).${unread}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const INTAKE_LINE_CATEGORIES = 3;

function intakeCategoriesLine(counts: AttentionItem["counts"]): string | null {
  const categories = counts.intake_by_category ?? [];
  if (categories.length === 0) return null;
  const shown = categories
    .slice(0, INTAKE_LINE_CATEGORIES)
    .map((entry) => `${entry.category} ${entry.count}`);
  const other =
    categories.slice(INTAKE_LINE_CATEGORIES).reduce((sum, entry) => sum + entry.count, 0) +
    (counts.intake_categories_omitted ?? 0);
  if (other > 0) shown.push(`other ${other}`);
  return `by category: ${shown.join(" | ")}`;
}

export function attentionLine(item: AttentionItem): string {
  const subject = item.subject
    ? `${item.subject.kind} "${item.subject.name ?? item.subject.id}"`
    : item.kind;
  const counts = [
    item.counts.failures ? plural(item.counts.failures, "failure", "failures") : null,
    item.counts.patches ? plural(item.counts.patches, "fix", "fixes") : null,
    item.counts.skills ? plural(item.counts.skills, "skill proposal", "skill proposals") : null,
    item.counts.intake
      ? plural(item.counts.intake, "collected item to review", "collected items to review")
      : null,
    intakeCategoriesLine(item.counts),
    item.approval ? `v${item.approval.version}` : null,
    item.approval ? item.approval.environment : null,
    item.repair?.step_id
      ? `step "${item.repair.step_id}"${item.repair.code ? ` ${item.repair.code.replace(/_/g, " ")}` : ""}`
      : null,
    item.repair && item.repair.steps > 1 ? `${item.repair.steps} steps blocked` : null,
    item.repair ? `remedy: ${item.repair.remedy_kind}` : null,
  ].filter((part): part is string => part !== null);
  const tail = counts.length > 0 ? ` (${counts.join(", ")})` : "";
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `- [${item.class}] ${subject}: ${item.reason.replace(/_/g, " ")}${tail}${detail}`;
}

const ORIGIN_TAG: Record<FailureOrigin, string> = {
  authoring: "[authoring]",
  manual: "[manual]",
  scheduled: "[scheduled]",
  mixed: "[mixed]",
};

const RISK_TAG: Record<RiskSignal["severity"], string> = {
  warn: "[warn]",
  critical: "[critical]",
};

export function renderDigest(
  headline: string,
  windowHours: number,
  attention: AttentionV1,
  groups: DigestFailureGroup[],
  risk: RiskSignal[],
): string {
  if (attention.items.length === 0 && groups.length === 0 && risk.length === 0) return headline;
  const lines: string[] = [headline];
  if (attention.items.length > 0) {
    lines.push("");
    for (const item of attention.items) lines.push(attentionLine(item));
  }
  if (risk.length > 0) {
    lines.push("", "Risk signals (leading indicators):");
    for (const r of risk) {
      lines.push(`${RISK_TAG[r.severity]} ${r.headline}`);
      lines.push(`   ${r.detail}`);
    }
  }
  if (groups.length > 0) {
    lines.push("", `Failed runs in the last ${windowHours}h, by cause:`);
    for (const g of groups) {
      const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
      const times = g.count === 1 ? "once" : `${g.count}×`;
      lines.push(`${ORIGIN_TAG[g.origin]} ${label} — failed ${times} (last ${g.last_seen})`);
      lines.push(`   ${g.cause}`);
      if (g.resolved_at) lines.push(`   last ran clean on its schedule ${g.resolved_at}`);
    }
  }
  lines.push("", "Ask me to walk through any of these.");
  return lines.join("\n");
}

interface PendingPatchFact {
  readonly id: string;
  readonly workflow_id: string;
  readonly classification: "safe" | "unsafe";
  readonly created_at: Date;
  readonly diff: unknown;
}

const STUCK_PATCH_DAYS = 3;

export function projectPendingPatches(
  pendingRows: readonly PendingPatchFact[],
  workflowNames: ReadonlyMap<string, string>,
  generatedAtMs: number,
): DigestPatch[] {
  return pendingRows
    .map((r) => {
      const proposal = asRecord(asRecord(r.diff).proposal);
      const ageDays = Math.floor((generatedAtMs - r.created_at.getTime()) / (24 * 60 * 60 * 1000));
      return {
        id: r.id,
        workflow_id: r.workflow_id,
        workflow_name: workflowNames.get(r.workflow_id) ?? null,
        classification: r.classification,
        age_days: ageDays,
        stuck: ageDays >= STUCK_PATCH_DAYS,
        summary:
          typeof proposal.description === "string"
            ? proposal.description
            : "Self-healing fix awaiting review",
      };
    })
    .sort(
      (a, b) =>
        b.age_days - a.age_days ||
        Number(b.classification === "unsafe") - Number(a.classification === "unsafe"),
    );
}
