import { and, desc, eq, gte, inArray, isNull, max } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { executionSteps, executions, workflows } from "../db/schema/index.ts";
import { monthlyUsage, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import { type AttentionV1, attentionAllClear, buildAttention } from "./attention.ts";
import {
  attentionHeadline,
  attentionLine,
  type DigestFailureGroup,
  groupFailureFacts,
  type OperatorHealthDigest,
  projectPendingPatches,
  renderDigest,
} from "./core/health-digest.ts";
import { computeRiskSignals } from "./risk-signals.ts";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_SCANNED_EXECUTIONS = 500;
export const DECISION_FAILURE_WINDOW_HOURS = 168;
export const MAX_PENDING_PATCHES = 50;

export {
  attentionLine,
  type DigestFailureGroup,
  type DigestPatch,
  type FailureOrigin,
  failingScheduledGroups,
  type OperatorHealthDigest,
} from "./core/health-digest.ts";

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

  const groups = groupFailureFacts(failedExecs, failedSteps);

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

  const patchItems = projectPendingPatches(pendingRows, patchNameById, generatedAt.getTime());

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

const MCP_SUMMARY_TOP_N = 10;

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
