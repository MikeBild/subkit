import { and, desc, eq, gte, inArray, isNull, max } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { executionSteps, executions, workflows } from "../db/schema/index.ts";
import {
  classifyPersistedFailure,
  humanizeClassification,
  type PreviewClassification,
} from "../execution/classify.ts";
import { classifyRunFailure, pickStoppingStep } from "../execution/outcome.ts";
import { monthlyUsage, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import {
  type AttentionItem,
  type AttentionV1,
  attentionAllClear,
  buildAttention,
} from "./attention.ts";
import { computeRiskSignals, type RiskSignal } from "./risk-signals.ts";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_SCANNED_EXECUTIONS = 500;
export const DECISION_FAILURE_WINDOW_HOURS = 168;
export const MAX_PENDING_PATCHES = 50;
const STUCK_PATCH_DAYS = 3;

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

async function markRecoveredGroups(
  db: Db,
  tenant_id: string,
  groups: DigestFailureGroup[],
): Promise<void> {
  const candidates = groups.filter((group) => group.workflow_id && group.scheduled_count > 0);
  if (!candidates.length) return;
  const workflowIds = [...new Set(candidates.map((group) => group.workflow_id as string))];
  const earliest = candidates.reduce(
    (min, group) => (group.last_seen < min ? group.last_seen : min),
    candidates[0]?.last_seen ?? "",
  );

  const latest = await db
    .select({ workflow_id: executions.workflow_id, at: max(executions.created_at) })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.status, "succeeded"),
        eq(executions.request_source, "scheduler"),
        inArray(executions.workflow_id, workflowIds),
        gte(executions.created_at, new Date(earliest)),
      ),
    )
    .groupBy(executions.workflow_id);

  const latestByWorkflow = new Map(
    latest.flatMap((row) =>
      row.workflow_id && row.at ? [[row.workflow_id, row.at.toISOString()] as const] : [],
    ),
  );
  for (const group of candidates) {
    const at = latestByWorkflow.get(group.workflow_id as string);
    group.resolved_at = at && at > group.last_seen ? at : null;
  }
}

export async function collectFailureGroups(
  db: Db,
  tenant_id: string,
  windowHours: number,
  generatedAt: Date = new Date(),
): Promise<DigestFailureGroup[]> {
  const cutoff = new Date(generatedAt.getTime() - windowHours * 60 * 60 * 1000);

  const failedExecs = await db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      source_kind: executions.source_kind,
      source_ref: executions.source_ref,
      request_source: executions.request_source,
      created_at: executions.created_at,
      status: executions.status,
      failure: executions.failure,
    })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.status, "failed"),
        gte(executions.created_at, cutoff),
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(MAX_SCANNED_EXECUTIONS);

  const execIds = failedExecs.map((e) => e.id);
  const failedSteps = execIds.length
    ? await db
        .select({
          execution_id: executionSteps.execution_id,
          step_key: executionSteps.step_key,
          status: executionSteps.status,
          error: executionSteps.error,
          started_at: executionSteps.started_at,
          request_meta: executionSteps.request_meta,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, tenant_id),
            inArray(executionSteps.execution_id, execIds),
            inArray(executionSteps.status, ["failed", "timed_out", "aborted"]),
          ),
        )
    : [];

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

  await markRecoveredGroups(db, tenant_id, [...groups.values()]);

  const wfIds = [
    ...new Set([...groups.values()].map((g) => g.workflow_id).filter(Boolean)),
  ] as string[];
  if (wfIds.length) {
    const wfRows = await db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, tenant_id),
          inArray(workflows.id, wfIds),
          isNull(workflows.deleted_at),
        ),
      );
    const nameById = new Map(wfRows.map((r) => [r.id, r.name]));
    for (const [signature, g] of groups) {
      if (!g.workflow_id) continue;
      const name = nameById.get(g.workflow_id);
      if (name === undefined) groups.delete(signature);
      else g.workflow_name = name;
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen),
  );
}

export function failingScheduledGroups(
  groups: readonly DigestFailureGroup[],
): DigestFailureGroup[] {
  return groups.filter((group) => group.scheduled_count > 0 && group.resolved_at === null);
}

export async function buildOperatorHealthDigest(
  db: Db,
  principal: ResolvedPrincipal,
  opts?: { window_hours?: number },
): Promise<OperatorHealthDigest> {
  const tenant_id = principal.tenant_id;
  const windowHours = opts?.window_hours ?? DEFAULT_WINDOW_HOURS;
  const generatedAt = new Date();
  const [failureGroups, openDecisions, attention] = await Promise.all([
    collectFailureGroups(db, tenant_id, windowHours, generatedAt),
    readOpenPatchDecisions(db, tenant_id, { limit: MAX_PENDING_PATCHES }),
    buildAttention(db, principal, { now: generatedAt }),
  ]);
  const openTotal = openDecisions.open_total;
  const pendingRows = openDecisions.items.map((item) => item.row);

  const patchWfIds = [...new Set(pendingRows.map((r) => r.workflow_id))];
  const patchNameById = patchWfIds.length
    ? new Map(
        (
          await db
            .select({ id: workflows.id, name: workflows.name })
            .from(workflows)
            .where(and(eq(workflows.tenant_id, tenant_id), inArray(workflows.id, patchWfIds)))
        ).map((r) => [r.id, r.name]),
      )
    : new Map<string, string>();

  const patchItems: DigestPatch[] = pendingRows
    .map((r) => {
      const proposal = asRecord(asRecord(r.diff).proposal);
      const ageDays = Math.floor(
        (generatedAt.getTime() - r.created_at.getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        id: r.id,
        workflow_id: r.workflow_id,
        workflow_name: patchNameById.get(r.workflow_id) ?? null,
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

  const risk = computeRiskSignals({
    monthTokens: await monthlyUsage(tenant_id, db),
    monthBudget: resolveMonthlyBudget(tenant_id),
  });

  const headline = attentionHeadline(attention);
  const rendered = renderDigest(headline, windowHours, attention, failureGroups, risk);

  return {
    generated_at: generatedAt.toISOString(),
    window_hours: windowHours,
    headline,
    failure_groups: failureGroups,
    patch_candidates: { open: openTotal, items: patchItems },
    risk,
    attention,
    rendered,
    all_clear: attentionAllClear(attention),
  };
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

function renderDigest(
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

export const MCP_SUMMARY_TOP_N = 10;

export async function buildOperatorHealthSummary(
  db: Db,
  principal: ResolvedPrincipal,
): Promise<{ attention: AttentionV1; text: string }> {
  const attention = await buildAttention(db, principal);
  const parts: string[] = [attentionHeadline(attention)];
  const shown = attention.items.slice(0, MCP_SUMMARY_TOP_N);
  for (const item of shown) parts.push(attentionLine(item));
  const more = attention.items.length - shown.length;
  if (more > 0) parts.push(`- (+${more} more — call get_attention for the full list)`);
  return { attention, text: parts.join("\n") };
}
