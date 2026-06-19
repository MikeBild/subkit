// Operator health digest — a deterministic, LLM-free summary of what
// needs a human's attention on a tenant right now.
//
// Two surfaces consume it:
//   * GET /v1/operator/health-digest (this slice) — the `sk` REPL fetches
//     it at startup and renders it as a colored first assistant turn.
//   * the structured payload is injected as conversation context so the
//     LLM can act on the failures (diagnose / approve patches / fix
//     inputs) without re-deriving them.
//
// It groups failed executions by ROOT-CAUSE SIGNATURE — (workflow, step,
// error code) — rather than listing 250 independent rows, tags each
// group by where it came from (authoring trial-run vs manual test vs
// scheduled workflow), and reuses the runtime failure classifier so
// the cause reads like a sentence, not a stack trace. Pending patch
// candidates ride along as the "fixes awaiting review" bucket.

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executionSteps, executions, patchCandidates, workflows } from "../db/schema/index.ts";
import { classifyFailure, humanizeClassification } from "../execution/classify.ts";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_SCANNED_EXECUTIONS = 500;
const MAX_PENDING_PATCHES = 50;

/** Where a failed run came from. Authoring trial-runs and manual test
 *  runs are NOT production incidents — the tag keeps them honest. */
export type FailureOrigin = "authoring" | "manual" | "scheduled" | "mixed";

export interface DigestFailureGroup {
  signature: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  error_code: string | null;
  origin: FailureOrigin;
  count: number;
  last_seen: string;
  /** One-sentence human cause, classifier-derived. */
  cause: string;
  /** The connector-authored remediation hint, when the step carried one. */
  guidance: string | null;
}

export interface DigestPatch {
  id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  classification: "safe" | "unsafe";
  summary: string;
}

export interface OperatorHealthDigest {
  generated_at: string;
  window_hours: number;
  /** Outcome-first one-liner for the chat surface. */
  headline: string;
  failure_groups: DigestFailureGroup[];
  patch_candidates: { pending: number; items: DigestPatch[] };
  /** Plain-text fallback render; the CLI styles its own from the
   *  structured fields above. */
  rendered: string;
  /** True when there is genuinely nothing to report. */
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

export async function buildOperatorHealthDigest(
  db: Db,
  tenant_id: string,
  opts?: { window_hours?: number },
): Promise<OperatorHealthDigest> {
  const windowHours = opts?.window_hours ?? DEFAULT_WINDOW_HOURS;
  const generatedAt = new Date();
  const cutoff = new Date(generatedAt.getTime() - windowHours * 60 * 60 * 1000);

  const failedExecs = await db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      source_kind: executions.source_kind,
      source_ref: executions.source_ref,
      request_source: executions.request_source,
      created_at: executions.created_at,
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
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, tenant_id),
            inArray(executionSteps.execution_id, execIds),
            eq(executionSteps.status, "failed"),
          ),
        )
    : [];

  // First failed step per execution (the one that stopped the run).
  const stepByExec = new Map<string, (typeof failedSteps)[number]>();
  for (const s of failedSteps) {
    if (!stepByExec.has(s.execution_id)) stepByExec.set(s.execution_id, s);
  }

  // Group by root-cause signature.
  const groups = new Map<string, DigestFailureGroup>();
  for (const exec of failedExecs) {
    const step = stepByExec.get(exec.id);
    const err = asRecord(step?.error);
    const errorCode = typeof err.code === "string" ? err.code : null;
    const message = typeof err.message === "string" ? err.message : "";
    const guidance = typeof err.guidance === "string" ? err.guidance : null;
    const stepKey = step?.step_key ?? null;
    const wfKey = exec.workflow_id ?? `${exec.source_kind}`;
    const signature = `${wfKey}:${stepKey ?? "-"}:${errorCode ?? "-"}`;
    const origin = originOf(exec);
    const lastSeen = exec.created_at.toISOString();

    const existing = groups.get(signature);
    if (existing) {
      existing.count += 1;
      existing.origin = mergeOrigin(existing.origin, origin);
      if (lastSeen > existing.last_seen) existing.last_seen = lastSeen;
      continue;
    }

    const classification = classifyFailure({
      status: "failed",
      retry_count: 0,
      duration_ms: 0,
      error: errorCode ? { code: errorCode, message } : null,
    });
    const cause =
      guidance ?? humanizeClassification(classification, message, step?.status ?? "step");

    groups.set(signature, {
      signature,
      workflow_id: exec.workflow_id ?? null,
      workflow_name:
        exec.workflow_id === null ? ((asRecord(exec.source_ref).name as string) ?? null) : null,
      step_key: stepKey,
      error_code: errorCode,
      origin,
      count: 1,
      last_seen: lastSeen,
      cause,
      guidance,
    });
  }

  // Resolve workflow names for saved-workflow groups.
  const wfIds = [
    ...new Set([...groups.values()].map((g) => g.workflow_id).filter(Boolean)),
  ] as string[];
  if (wfIds.length) {
    const wfRows = await db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), inArray(workflows.id, wfIds)));
    const nameById = new Map(wfRows.map((r) => [r.id, r.name]));
    for (const g of groups.values()) {
      if (g.workflow_id) g.workflow_name = nameById.get(g.workflow_id) ?? null;
    }
  }

  const failureGroups = [...groups.values()].sort(
    (a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen),
  );

  // Pending patch candidates (post-flood-fix: ~1 per endpoint).
  const pendingRows = await db
    .select()
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, tenant_id), eq(patchCandidates.status, "proposed")))
    .orderBy(desc(patchCandidates.created_at))
    .limit(MAX_PENDING_PATCHES);

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

  const patchItems: DigestPatch[] = pendingRows.map((r) => {
    const proposal = asRecord(asRecord(r.diff).proposal);
    return {
      id: r.id,
      workflow_id: r.workflow_id,
      workflow_name: patchNameById.get(r.workflow_id) ?? null,
      classification: r.classification,
      summary:
        typeof proposal.description === "string"
          ? proposal.description
          : "Self-healing fix awaiting review",
    };
  });

  const allClear = failureGroups.length === 0 && patchItems.length === 0;
  const headline = buildHeadline(failureGroups, patchItems.length);
  const rendered = renderDigest(headline, windowHours, failureGroups, patchItems);

  return {
    generated_at: generatedAt.toISOString(),
    window_hours: windowHours,
    headline,
    failure_groups: failureGroups,
    patch_candidates: { pending: patchItems.length, items: patchItems },
    rendered,
    all_clear: allClear,
  };
}

function buildHeadline(groups: DigestFailureGroup[], patchCount: number): string {
  if (groups.length === 0 && patchCount === 0) {
    return "All workflows healthy — nothing needs your attention.";
  }
  const operational = groups.filter((g) => g.origin === "scheduled").length;
  const parts: string[] = [];
  if (operational > 0) {
    parts.push(`${operational} scheduled workflow${operational === 1 ? "" : "s"} failing`);
  }
  const nonScheduled = groups.length - operational;
  if (nonScheduled > 0) {
    parts.push(`${nonScheduled} test/authoring failure${nonScheduled === 1 ? "" : "s"}`);
  }
  if (patchCount > 0) {
    parts.push(`${patchCount} fix${patchCount === 1 ? "" : "es"} awaiting review`);
  }
  return `Needs attention: ${parts.join(", ")}.`;
}

const ORIGIN_TAG: Record<FailureOrigin, string> = {
  authoring: "[authoring]",
  manual: "[manual]",
  scheduled: "[scheduled]",
  mixed: "[mixed]",
};

function renderDigest(
  headline: string,
  windowHours: number,
  groups: DigestFailureGroup[],
  patches: DigestPatch[],
): string {
  if (groups.length === 0 && patches.length === 0) return headline;
  const lines: string[] = [headline, ""];
  for (const g of groups) {
    const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
    const times = g.count === 1 ? "once" : `${g.count}×`;
    lines.push(`${ORIGIN_TAG[g.origin]} ${label} — failed ${times} (last ${g.last_seen})`);
    lines.push(`   ${g.cause}`);
  }
  if (patches.length > 0) {
    lines.push("");
    lines.push(
      `${patches.length} self-healing fix${patches.length === 1 ? "" : "es"} awaiting review:`,
    );
    for (const p of patches) {
      const label = p.workflow_name ?? p.workflow_id ?? "(workflow)";
      lines.push(`   • ${label} [${p.classification}]: ${p.summary}`);
    }
  }
  lines.push("");
  lines.push(`Scanned the last ${windowHours}h. Ask me to walk through any of these.`);
  return lines.join("\n");
}
