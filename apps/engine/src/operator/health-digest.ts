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
import { AuditAction, audit } from "../audit/index.ts";
import {
  RiskSignalClearedMetadataSchema,
  RiskSignalRaisedMetadataSchema,
  SYSTEM_TENANT_ID,
} from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { executionSteps, executions, patchCandidates, workflows } from "../db/schema/index.ts";
import { classifyFailure, humanizeClassification } from "../execution/classify.ts";
import { getContext } from "../logging/context.ts";
import { computeRiskSignals, type RiskSignal, takeRiskEdges, topRisk } from "./risk-signals.ts";

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
  /** Leading-indicator risk signals computed from the live process
   *  gauges/counters vs the operator-tuned predictive thresholds. The
   *  failure groups above are lagging (a run already failed); these flag
   *  what is trending toward an incident. Highest-severity first. */
  risk: RiskSignal[];
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
  // `audit` (default true): emit the RISK_SIGNAL_* edge audits + advance the
  // process-scoped edge tracker. The canonical operator reads (the HTTP route,
  // the MCP resource) leave it on; the incidental read-only summaries (MCP
  // `initialize` instructions, `sk login`) pass `audit: false` so a connect or
  // a login is a pure read with no audit side-effect.
  opts?: { window_hours?: number; audit?: boolean },
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

  // Leading-indicator risks from the live process metrics. Pure read; the
  // builder stays deterministic for a fixed registry + config snapshot.
  const risk = computeRiskSignals();

  // Audit each critical risk ONCE on the false→true edge and once on recovery
  // — not on every digest read (the builder runs on every MCP connect /
  // resource read / REPL start). The signals are host-scoped shared
  // infrastructure, so rows land under the system tenant rather than the
  // reading tenant (which would duplicate one host condition across every
  // tenant that reads). `actor_id: null` is explicit (system, no human actor);
  // `request_source` carries the surface that triggered the read so SIEM can
  // split edges by entry point. Skipped entirely on read-only summary paths
  // (audit:false) so a connect/login is a pure read. Fire-and-forget: the
  // digest read must not block on the audit write.
  if (opts?.audit !== false) {
    const requestSource = getContext().request_source;
    const edges = await takeRiskEdges(db, risk);
    // Bind the audit insert to the SAME `db` the digest read from — not the
    // global `getDb()` pool the bare `audit()` would reach for. The digest is
    // already fully parameterised on `db`; letting its audit side-effect drift
    // to a different handle is a latent DB-routing inconsistency (and makes an
    // int test that injects a disposable db silently poison the process-global
    // pool, racing every other suite's audit writes).
    for (const r of edges.raised) {
      audit(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.RISK_SIGNAL_RAISED,
          resource_type: "operator_health_digest",
          resource_id: r.kind,
          result: "success",
          metadata: RiskSignalRaisedMetadataSchema.parse({
            kind: r.kind,
            severity: r.severity,
            metric: r.metric,
            value: r.value,
            threshold: r.threshold,
            // Boot-artifact discriminator: a low uptime means this raise is the
            // first digest read after a restart re-firing a standing critical,
            // not a fresh live transition.
            uptime_s: Math.round(process.uptime()),
            ...(requestSource ? { request_source: requestSource } : {}),
          }),
        },
        db,
      );
    }
    for (const kind of edges.cleared) {
      audit(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.RISK_SIGNAL_CLEARED,
          resource_type: "operator_health_digest",
          resource_id: kind,
          result: "success",
          metadata: RiskSignalClearedMetadataSchema.parse({
            kind,
            ...(requestSource ? { request_source: requestSource } : {}),
          }),
        },
        db,
      );
    }
  }

  const allClear = failureGroups.length === 0 && patchItems.length === 0 && risk.length === 0;
  const headline = buildHeadline(failureGroups, patchItems.length, risk);
  const rendered = renderDigest(headline, windowHours, failureGroups, patchItems, risk);

  return {
    generated_at: generatedAt.toISOString(),
    window_hours: windowHours,
    headline,
    failure_groups: failureGroups,
    patch_candidates: { pending: patchItems.length, items: patchItems },
    risk,
    rendered,
    all_clear: allClear,
  };
}

function buildHeadline(
  groups: DigestFailureGroup[],
  patchCount: number,
  risk: RiskSignal[],
): string {
  const top = topRisk(risk);
  if (groups.length === 0 && patchCount === 0 && risk.length === 0) {
    return "All workflows healthy — nothing needs your attention.";
  }
  const parts: string[] = [];
  // A critical leading risk leads the headline — the host is about to fail,
  // which the lagging failure groups can't yet see.
  if (top?.severity === "critical") {
    parts.push(top.headline);
  }
  const operational = groups.filter((g) => g.origin === "scheduled").length;
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
  // Non-critical risks ride along as a count so they're never lost.
  const warnRisks = risk.filter((r) => r.severity !== "critical").length;
  if (warnRisks > 0) {
    parts.push(`${warnRisks} risk${warnRisks === 1 ? "" : "s"} trending`);
  }
  return `Needs attention: ${parts.join(", ")}.`;
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
  groups: DigestFailureGroup[],
  patches: DigestPatch[],
  risk: RiskSignal[],
): string {
  if (groups.length === 0 && patches.length === 0 && risk.length === 0) return headline;
  const lines: string[] = [headline, ""];
  if (risk.length > 0) {
    lines.push("Risk signals (leading indicators):");
    for (const r of risk) {
      lines.push(`${RISK_TAG[r.severity]} ${r.headline}`);
      lines.push(`   ${r.detail}`);
    }
    lines.push("");
  }
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

/** How many risk lines the compact MCP summary carries before collapsing the
 *  tail to a "+N more" count. Keeps the `instructions` string short enough to
 *  ride every initialize without bloating the handshake. */
const MCP_SUMMARY_TOP_N = 3;

/**
 * Compact one-paragraph health/risk summary for the MCP surface — the
 * `instructions` string handed to the client at connect, the
 * `subkit://operator/health-digest` resource body, and the `get_engine_status`
 * tail. Bounded to the top-N risks so it never bloats the handshake. Reuses
 * the same digest builder as every other surface — one source of truth.
 */
export async function buildOperatorHealthSummary(
  db: Db,
  tenant_id: string,
): Promise<{ digest: OperatorHealthDigest; text: string }> {
  // `audit: false` — this is the incidental read-only path (MCP `initialize`
  // instructions + `sk login`). The RISK_SIGNAL_* edge audits fire only on the
  // deliberate operator digest reads (HTTP route, MCP resource), so a connect
  // or login never advances the edge tracker or writes an audit row.
  const digest = await buildOperatorHealthDigest(db, tenant_id, { audit: false });
  if (digest.all_clear) {
    return { digest, text: "Engine health: all clear — no failing runs, pending fixes, or risks." };
  }
  const parts: string[] = [digest.headline];
  if (digest.risk.length > 0) {
    const shown = digest.risk.slice(0, MCP_SUMMARY_TOP_N);
    for (const r of shown) parts.push(`- [${r.severity}] ${r.headline}`);
    const more = digest.risk.length - shown.length;
    if (more > 0) parts.push(`- (+${more} more risk${more === 1 ? "" : "s"})`);
  }
  return { digest, text: parts.join("\n") };
}
