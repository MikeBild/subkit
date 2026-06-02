// Skill Candidates service — CRUD, pattern analysis, approval, and rejection.
//
// Candidates are NEVER auto-promoted. Every mutation goes through an
// explicit human gate (conversation approval or REST API).

import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, getDb } from "../db/client.ts";
import { patchCandidates } from "../db/schema/executions.ts";
import { skillCandidateEvidence, skillCandidates } from "../db/schema/skills.ts";
import { log } from "../logging/logger.ts";
import {
  recordLoopPatchToSkillCandidate,
  recordLoopSkillCandidatePromoted,
} from "../observability/instrumentation.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";
import { createSkill } from "../skills/service.ts";
import { now } from "../utils/clock.ts";
import {
  detectFailurePatterns,
  detectRepairPatterns,
  detectSuccessPatterns,
} from "./detectors/index.ts";
import type {
  AnalysisResult,
  ApproveSkillCandidateParams,
  ListSkillCandidatesParams,
  PatternSignal,
  RejectSkillCandidateParams,
  SkillCandidateEvidenceView,
  SkillCandidateView,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const MAX_EVIDENCE_PER_CANDIDATE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a DB row to a view. evidence_count defaults to 0 — callers that
 *  need the real count should query the relational evidence table. */
function toView(row: typeof skillCandidates.$inferSelect, evidenceCount = 0): SkillCandidateView {
  const blob = (row.examples ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    scope: row.scope,
    connector_id: row.connector_id,
    workflow_id: row.workflow_id,
    pattern_kind: row.pattern_kind,
    title: row.title,
    body: row.body,
    examples: (blob.examples as string[]) ?? [],
    best_practices: (blob.best_practices as string[]) ?? [],
    pitfalls: (blob.pitfalls as string[]) ?? [],
    doc_refs: (blob.doc_refs as string[]) ?? [],
    evidence_count: evidenceCount,
    confidence: row.confidence,
    status: row.status,
    promoted_skill_id: row.promoted_skill_id,
    fingerprint: row.fingerprint,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Batch-fetch evidence counts for a set of candidate IDs. */
async function getEvidenceCounts(
  candidateIds: string[],
  exec: Executor,
): Promise<Map<string, number>> {
  if (candidateIds.length === 0) return new Map();
  const db = exec;
  // tenant-filter:exempt — skill_candidate_evidence has no tenant_id column (FK-cascade to skill_candidates.id); callers MUST pre-filter candidate ids via listSkillCandidates / getSkillCandidate, both of which scope on tenant_id
  const rows = await db
    .select({
      candidate_id: skillCandidateEvidence.skill_candidate_id,
      cnt: count(),
    })
    .from(skillCandidateEvidence)
    .where(
      sql`${skillCandidateEvidence.skill_candidate_id} IN (${sql.join(
        candidateIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    .groupBy(skillCandidateEvidence.skill_candidate_id);

  const m = new Map<string, number>();
  for (const r of rows) m.set(r.candidate_id, Number(r.cnt));
  return m;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listSkillCandidates(
  p: ListSkillCandidatesParams,
  exec?: Executor,
): Promise<SkillCandidateView[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 50), 500);
  const offset = Math.max(0, p.offset ?? 0);

  const tenantConds = [eq(skillCandidates.tenant_id, p.tenant_id)];
  if (p.status) tenantConds.push(eq(skillCandidates.status, p.status));
  if (p.scope) tenantConds.push(eq(skillCandidates.scope, p.scope));
  if (p.connector_id) tenantConds.push(eq(skillCandidates.connector_id, p.connector_id));
  if (p.workflow_id) tenantConds.push(eq(skillCandidates.workflow_id, p.workflow_id));
  if (p.pattern_kind) tenantConds.push(eq(skillCandidates.pattern_kind, p.pattern_kind));
  if (p.confidence) tenantConds.push(eq(skillCandidates.confidence, p.confidence));

  const rows = await db
    .select()
    .from(skillCandidates)
    .where(and(...tenantConds))
    .orderBy(desc(skillCandidates.created_at))
    .limit(limit)
    .offset(offset);

  const counts = await getEvidenceCounts(
    rows.map((r) => r.id),
    db,
  );
  return rows.map((r) => toView(r, counts.get(r.id) ?? 0));
}

/**
 * Hard cap on the number of proposed candidates the assembler ever sees
 * in a single authoring turn. Section-level pre-trim (1200 tokens, in
 * the assembler) is the second bound; this is the first.
 */
export const LIST_PROPOSED_FOR_AUTHORING_CAP = 8;

/**
 * Return up to LIST_PROPOSED_FOR_AUTHORING_CAP proposed candidates for an authoring turn, merged from
 * (global ∪ optional-connector ∪ optional-workflow) and ordered by
 * (scope-specificity, confidence, evidence-count, created_at) descending.
 * On id collision, the more specific scope wins (workflow > connector >
 * global). Each per-scope page overfetches to the service ceiling so
 * older high-confidence candidates aren't dropped by the underlying
 * `created_at DESC` paging before ranking.
 */
export async function listProposedForAuthoring(
  tenant_id: string,
  scope_hints: { connector_id?: string; workflow_id?: string },
  exec?: Executor,
): Promise<SkillCandidateView[]> {
  const db = exec ?? getDb();
  const start = Date.now();
  const scopeHint = scope_hints.workflow_id
    ? "workflow"
    : scope_hints.connector_id
      ? "connector"
      : "global";

  const [globalRows, connectorRows, workflowRows] = await Promise.all([
    listSkillCandidates({ tenant_id, status: "proposed", scope: "global", limit: 500 }, db),
    scope_hints.connector_id
      ? listSkillCandidates(
          {
            tenant_id,
            status: "proposed",
            scope: "connector",
            connector_id: scope_hints.connector_id,
            limit: 500,
          },
          db,
        )
      : Promise.resolve<SkillCandidateView[]>([]),
    scope_hints.workflow_id
      ? listSkillCandidates(
          {
            tenant_id,
            status: "proposed",
            scope: "workflow",
            workflow_id: scope_hints.workflow_id,
            limit: 500,
          },
          db,
        )
      : Promise.resolve<SkillCandidateView[]>([]),
  ]);

  // The three queries are AND-exact-match on disjoint `scope` values
  // (global / connector / workflow), so a single row cannot appear in
  // more than one result set — no dedup needed.
  const merged: SkillCandidateView[] = [...globalRows, ...connectorRows, ...workflowRows];

  const scopeSpecificity = (scope: SkillCandidateView["scope"]): number =>
    scope === "workflow" ? 3 : scope === "connector" ? 2 : 1;
  const confidenceRank = (c: SkillCandidateView["confidence"]): number =>
    c === "high" ? 3 : c === "medium" ? 2 : 1;

  const sorted = merged.sort((a, b) => {
    const ds = scopeSpecificity(b.scope) - scopeSpecificity(a.scope);
    if (ds !== 0) return ds;
    const dc = confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (dc !== 0) return dc;
    const de = b.evidence_count - a.evidence_count;
    if (de !== 0) return de;
    // created_at is an ISO-8601 string — lexicographic compare matches
    // chronological order. Descending: newest first.
    if (a.created_at < b.created_at) return 1;
    if (a.created_at > b.created_at) return -1;
    return 0;
  });

  const out = sorted.slice(0, LIST_PROPOSED_FOR_AUTHORING_CAP);
  try {
    getMetrics().observe(
      METRIC_NAMES.LLM_LIST_PROPOSED_FOR_AUTHORING_DURATION_MS,
      Date.now() - start,
      { scope_hint: scopeHint },
    );
  } catch {
    // Metrics emission is best-effort — never fail the authoring path.
  }
  return out;
}

export async function getSkillCandidate(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<SkillCandidateView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(skillCandidates)
    .where(and(eq(skillCandidates.tenant_id, tenant_id), eq(skillCandidates.id, id)))
    .limit(1);
  if (!rows[0]) return null;
  const counts = await getEvidenceCounts([rows[0].id], db);
  return toView(rows[0], counts.get(rows[0].id) ?? 0);
}

export async function getSkillCandidateEvidence(
  tenant_id: string,
  candidate_id: string,
  exec?: Executor,
): Promise<SkillCandidateEvidenceView[]> {
  const db = exec ?? getDb();
  // Verify candidate belongs to tenant
  const candidate = await getSkillCandidate(tenant_id, candidate_id, db);
  if (!candidate) return [];

  // tenant-filter:exempt — skill_candidate_evidence has no tenant_id column (FK-cascade to skill_candidates.id); the candidate above was already tenant-checked via getSkillCandidate
  const rows = await db
    .select()
    .from(skillCandidateEvidence)
    .where(eq(skillCandidateEvidence.skill_candidate_id, candidate_id))
    .orderBy(desc(skillCandidateEvidence.captured_at));

  return rows.map((r) => ({
    id: r.id,
    skill_candidate_id: r.skill_candidate_id,
    execution_id: r.execution_id,
    patch_candidate_id: r.patch_candidate_id,
    evidence_type: r.evidence_type,
    summary: r.summary,
    captured_at: r.captured_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Upsert (internal — called by detectors)
// ---------------------------------------------------------------------------

async function upsertFromSignal(
  tenant_id: string,
  signal: PatternSignal,
  exec: Db,
): Promise<{ action: "proposed" | "updated" | "skipped" }> {
  return await exec.transaction(async (tx) => {
    // Check for existing candidate with same fingerprint
    const existing = await tx
      .select()
      .from(skillCandidates)
      .where(
        and(
          eq(skillCandidates.tenant_id, tenant_id),
          eq(skillCandidates.fingerprint, signal.fingerprint),
        ),
      )
      .limit(1);

    if (existing[0]) {
      const row = existing[0];
      // If rejected or superseded, don't re-propose
      if (row.status === "rejected" || row.status === "superseded") {
        log.skill.candidate.dedup({
          candidate_id: row.id,
          tenant_id,
          pattern_kind: signal.pattern_kind,
          reason: row.status,
        });
        return { action: "skipped" as const };
      }
      // If already approved, skip
      if (row.status === "approved") {
        log.skill.candidate.dedup({
          candidate_id: row.id,
          tenant_id,
          pattern_kind: signal.pattern_kind,
          reason: "approved",
        });
        return { action: "skipped" as const };
      }
      // Update existing proposed candidate (bump version, update confidence)
      await tx
        .update(skillCandidates)
        .set({
          confidence: signal.confidence,
          version: row.version + 1,
          evidence: signal.evidence,
          updated_at: new Date(),
        })
        .where(eq(skillCandidates.id, row.id));

      // Add new evidence entries (cap at MAX_EVIDENCE_PER_CANDIDATE)
      // tenant-filter:exempt — skill_candidate_evidence has no tenant_id column (FK-cascade to skill_candidates.id); `row` was loaded above with eq(skillCandidates.tenant_id, tenant_id)
      const existingEvidence = await tx
        .select()
        .from(skillCandidateEvidence)
        .where(eq(skillCandidateEvidence.skill_candidate_id, row.id));

      const remaining = MAX_EVIDENCE_PER_CANDIDATE - existingEvidence.length;
      if (remaining > 0) {
        const newEvidence = signal.evidence.slice(0, remaining);
        if (newEvidence.length > 0) {
          await tx.insert(skillCandidateEvidence).values(
            newEvidence.map((e) => ({
              skill_candidate_id: row.id,
              execution_id: e.execution_id ?? null,
              patch_candidate_id: e.patch_candidate_id ?? null,
              evidence_type: e.evidence_type,
              summary: e.summary,
            })),
          );
        }
      }

      await auditAwait(
        {
          tenant_id,
          actor_type: "system",
          action: AuditAction.SKILL_CANDIDATE_UPDATED,
          resource_type: "skill_candidate",
          resource_id: row.id,
          result: "success",
          metadata: {
            pattern_kind: signal.pattern_kind,
            confidence: signal.confidence,
            version: row.version + 1,
          },
        },
        tx,
      );

      return { action: "updated" as const };
    }

    // Supersede existing proposed candidates for the same scope+entity
    // with a different fingerprint (pattern has evolved).
    const tenantSupersedeScope = [
      eq(skillCandidates.tenant_id, tenant_id),
      eq(skillCandidates.status, "proposed"),
      eq(skillCandidates.scope, signal.scope),
      eq(skillCandidates.pattern_kind, signal.pattern_kind),
    ];
    if (signal.workflow_id)
      tenantSupersedeScope.push(eq(skillCandidates.workflow_id, signal.workflow_id));
    if (signal.connector_id)
      tenantSupersedeScope.push(eq(skillCandidates.connector_id, signal.connector_id));

    const stale = await tx
      .select({ id: skillCandidates.id })
      .from(skillCandidates)
      .where(and(...tenantSupersedeScope));

    for (const s of stale) {
      await tx
        .update(skillCandidates)
        .set({ status: "superseded", updated_at: new Date() })
        .where(eq(skillCandidates.id, s.id));
      await auditAwait(
        {
          tenant_id,
          actor_type: "system",
          action: AuditAction.SKILL_CANDIDATE_SUPERSEDED,
          resource_type: "skill_candidate",
          resource_id: s.id,
          result: "success",
          metadata: { superseded_by_fingerprint: signal.fingerprint },
        },
        tx,
      );
    }

    // Create new candidate
    const [row] = await tx
      .insert(skillCandidates)
      .values({
        tenant_id,
        scope: signal.scope,
        connector_id: signal.connector_id ?? null,
        workflow_id: signal.workflow_id ?? null,
        pattern_kind: signal.pattern_kind,
        title: signal.title,
        body: signal.body,
        examples: {
          examples: signal.examples,
          best_practices: signal.best_practices,
          pitfalls: signal.pitfalls,
          doc_refs: signal.doc_refs,
        },
        evidence: signal.evidence,
        confidence: signal.confidence,
        fingerprint: signal.fingerprint,
      })
      .returning();

    assertInsertRow(row, "skill_candidates");

    // Insert evidence
    if (signal.evidence.length > 0) {
      await tx.insert(skillCandidateEvidence).values(
        signal.evidence.slice(0, MAX_EVIDENCE_PER_CANDIDATE).map((e) => ({
          skill_candidate_id: row.id,
          execution_id: e.execution_id ?? null,
          patch_candidate_id: e.patch_candidate_id ?? null,
          evidence_type: e.evidence_type,
          summary: e.summary,
        })),
      );
    }

    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.SKILL_CANDIDATE_PROPOSED,
        resource_type: "skill_candidate",
        resource_id: row.id,
        result: "success",
        metadata: {
          pattern_kind: signal.pattern_kind,
          confidence: signal.confidence,
          fingerprint: signal.fingerprint,
        },
      },
      tx,
    );

    log.skill.candidate.proposed({
      candidate_id: row.id,
      tenant_id,
      pattern_kind: signal.pattern_kind,
      confidence: signal.confidence,
      superseded_count: stale.length,
    });

    return { action: "proposed" as const };
  });
}

// ---------------------------------------------------------------------------
// Pattern analysis entry point
// ---------------------------------------------------------------------------

export async function runPatternAnalysis(
  params: { tenant_id: string },
  exec?: Db,
): Promise<AnalysisResult> {
  const db = exec ?? (getDb() as Db);

  // Run all detectors
  const [repairSignals, failureSignals, successSignals] = await Promise.all([
    detectRepairPatterns(params.tenant_id, db),
    detectFailurePatterns(params.tenant_id, db),
    detectSuccessPatterns(params.tenant_id, db),
  ]);

  const allSignals = [...repairSignals, ...failureSignals, ...successSignals];
  let proposed = 0;
  let updated = 0;

  for (const signal of allSignals) {
    const result = await upsertFromSignal(params.tenant_id, signal, db);
    if (result.action === "proposed") proposed++;
    if (result.action === "updated") updated++;
    // Middle edge of the Run → Drift → Patch → Skill loop (positioning.md §6):
    // a freshly-proposed candidate whose evidence carries a patch_candidate_id
    // is a Patch Candidate that became a Skill Candidate (the repair-pattern
    // detector path). #202's auto-aggregator will later feed the same counter.
    if (result.action === "proposed" && signal.evidence.some((e) => e.patch_candidate_id)) {
      recordLoopPatchToSkillCandidate({ tenant_id: params.tenant_id });
    }
  }

  log.info({
    module: "skill",
    action: "pattern_analysis.completed",
    msg: "pattern analysis pass completed",
    tenant_id: params.tenant_id,
    patterns_checked: allSignals.length,
    candidates_proposed: proposed,
    candidates_updated: updated,
    repair_signals: repairSignals.length,
    failure_signals: failureSignals.length,
    success_signals: successSignals.length,
  });

  return {
    candidates_proposed: proposed,
    candidates_updated: updated,
    patterns_checked: allSignals.length,
  };
}

// ---------------------------------------------------------------------------
// Human gate: Approve
// ---------------------------------------------------------------------------

export async function approveSkillCandidate(
  p: ApproveSkillCandidateParams,
  exec?: Db,
): Promise<{ candidate: SkillCandidateView; skill_id: string } | null> {
  const db = exec ?? (getDb() as Db);

  const out = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(skillCandidates)
      .where(
        and(
          eq(skillCandidates.tenant_id, p.tenant_id),
          eq(skillCandidates.id, p.candidate_id),
          eq(skillCandidates.status, "proposed"),
        ),
      )
      .limit(1);

    if (!rows[0]) return null;
    const row = rows[0];
    const blob = (row.examples ?? {}) as Record<string, unknown>;

    // Create a skill from the candidate
    const skill = await createSkill(
      {
        tenant_id: p.tenant_id,
        input: {
          scope: row.scope,
          connector_id: row.connector_id ?? undefined,
          workflow_id: row.workflow_id ?? undefined,
          title: p.overrides?.title ?? row.title,
          body: p.overrides?.body ?? row.body,
          status: p.overrides?.status ?? "draft",
          source: "candidate",
          examples: (blob.examples as string[]) ?? [],
          best_practices: (blob.best_practices as string[]) ?? [],
          pitfalls: (blob.pitfalls as string[]) ?? [],
          doc_refs: (blob.doc_refs as string[]) ?? [],
        },
        actor_id: p.actor_id,
      },
      tx,
    );

    // Update candidate status
    const [updated] = await tx
      .update(skillCandidates)
      .set({
        status: "approved",
        promoted_skill_id: skill.id,
        updated_at: new Date(),
      })
      .where(eq(skillCandidates.id, p.candidate_id))
      .returning();

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.SKILL_CANDIDATE_APPROVED,
        resource_type: "skill_candidate",
        resource_id: p.candidate_id,
        result: "success",
        metadata: {
          promoted_skill_id: skill.id,
          pattern_kind: row.pattern_kind,
        },
      },
      tx,
    );

    log.skill.candidate.approved({
      candidate_id: p.candidate_id,
      skill_id: skill.id,
      pattern_kind: row.pattern_kind,
      actor_id: p.actor_id,
    });

    // Promotion edge of the Run → Drift → Patch → Skill loop (positioning.md
    // §6). Lag is anchored to the EARLIEST linked Patch Candidate's created_at
    // (drift-detection time) — not the evidence-capture time — so the
    // histogram measures the true drift→skill journey. Candidates with no
    // patch evidence (failure/success patterns) leave lag_seconds undefined.
    // tenant-filter:exempt — evidence rows are FK children of the candidate
    // already tenant-verified above (skillCandidates filtered by p.tenant_id),
    // joined by skill_candidate_id; the parent scope constrains the tenant.
    const patchRows = await tx
      .select({ patch_candidate_id: skillCandidateEvidence.patch_candidate_id })
      .from(skillCandidateEvidence)
      .where(eq(skillCandidateEvidence.skill_candidate_id, p.candidate_id));
    const patchIds = patchRows
      .map((r) => r.patch_candidate_id)
      .filter((id): id is string => id !== null);
    let lag_seconds: number | undefined;
    if (patchIds.length > 0) {
      // tenant-filter:exempt — patchIds are drawn from the tenant-verified
      // candidate's evidence rows above, so the id set is already scoped to
      // the tenant; this only reads created_at to compute drift→skill lag.
      const earliest = await tx
        .select({ created_at: patchCandidates.created_at })
        .from(patchCandidates)
        .where(inArray(patchCandidates.id, patchIds))
        .orderBy(asc(patchCandidates.created_at))
        .limit(1);
      if (earliest[0]) {
        lag_seconds = (now() - earliest[0].created_at.getTime()) / 1000;
      }
    }

    return {
      candidate: updated ? toView(updated) : toView(row),
      skill_id: skill.id,
      // All candidates are detector-born today; `manual` is reserved for a
      // future hand-authored proposal path (see metrics.ts).
      promotion_source: "auto-suggested" as const,
      lag_seconds,
    };
  });

  if (!out) return null;

  recordLoopSkillCandidatePromoted({
    tenant_id: p.tenant_id,
    source: out.promotion_source,
    lag_seconds: out.lag_seconds,
  });

  return { candidate: out.candidate, skill_id: out.skill_id };
}

// ---------------------------------------------------------------------------
// Human gate: Reject
// ---------------------------------------------------------------------------

export async function rejectSkillCandidate(
  p: RejectSkillCandidateParams,
  exec?: Db,
): Promise<boolean> {
  const db = exec ?? (getDb() as Db);

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(skillCandidates)
      .where(
        and(
          eq(skillCandidates.tenant_id, p.tenant_id),
          eq(skillCandidates.id, p.candidate_id),
          eq(skillCandidates.status, "proposed"),
        ),
      )
      .limit(1);

    if (!rows[0]) return false;

    await tx
      .update(skillCandidates)
      .set({ status: "rejected", updated_at: new Date() })
      .where(eq(skillCandidates.id, p.candidate_id));

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.SKILL_CANDIDATE_REJECTED,
        resource_type: "skill_candidate",
        resource_id: p.candidate_id,
        result: "success",
        metadata: { reason: p.reason ?? null },
      },
      tx,
    );

    log.skill.candidate.rejected({
      candidate_id: p.candidate_id,
      actor_id: p.actor_id,
      reason: p.reason ?? null,
    });

    return true;
  });
}
