import { and, asc, count, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { actorIds, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import { patchCandidates } from "../db/schema/executions.ts";
import { skillCandidateEvidence, skillCandidates } from "../db/schema/skills.ts";
import { log } from "../logging/logger.ts";
import {
  recordLoopPatchToSkillCandidate,
  recordLoopSkillCandidatePromoted,
} from "../observability/instrumentation.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { createSkill, retireReplacedConnectorSkills } from "../skills/service.ts";
import { now } from "../utils/clock.ts";
import { skillReviewDigest, toView } from "./candidate-view.ts";
import { decideSignalUpsert } from "./core/candidate-decision.ts";
import { mergeCandidateEvidence, uniqueEvidence } from "./core/evidence.ts";
import { decideCandidateReview } from "./core/review.ts";
import { measureCorrectionEffectiveness } from "./correction-effectiveness.ts";
import { collectCorrectionIntake } from "./correction-intake.ts";
import {
  detectFailurePatterns,
  detectRepairPatterns,
  detectSuccessPatterns,
} from "./detectors/index.ts";
import {
  type AnalysisResult,
  type ApproveSkillCandidateParams,
  LEARNING_PATTERN_KINDS,
  type ListSkillCandidatesParams,
  type PatternSignal,
  type RejectSkillCandidateParams,
  type SkillCandidateEvidenceView,
  type SkillCandidateStatus,
  type SkillCandidateView,
} from "./types.ts";

const MAX_EVIDENCE_PER_CANDIDATE = 50;
const LEARNING_KINDS = [...LEARNING_PATTERN_KINDS];

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
      cnt: sql<number>`count(distinct (${skillCandidateEvidence.evidence_type}, ${skillCandidateEvidence.execution_id}, ${skillCandidateEvidence.patch_candidate_id}, CASE WHEN ${skillCandidateEvidence.execution_id} IS NULL AND ${skillCandidateEvidence.patch_candidate_id} IS NULL THEN ${skillCandidateEvidence.summary} ELSE NULL END))`,
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

function listFilterConds(p: ListSkillCandidatesParams) {
  const tenantConds = [eq(skillCandidates.tenant_id, p.tenant_id)];
  if (p.candidate_ids) tenantConds.push(inArray(skillCandidates.id, p.candidate_ids));
  if (p.status) tenantConds.push(eq(skillCandidates.status, p.status));
  if (p.statuses) tenantConds.push(inArray(skillCandidates.status, p.statuses));
  if (p.scope) tenantConds.push(eq(skillCandidates.scope, p.scope));
  if (p.connector_id) tenantConds.push(eq(skillCandidates.connector_id, p.connector_id));
  if (p.workflow_id) tenantConds.push(eq(skillCandidates.workflow_id, p.workflow_id));
  if (p.pattern_kind) tenantConds.push(eq(skillCandidates.pattern_kind, p.pattern_kind));
  if (p.confidence) tenantConds.push(eq(skillCandidates.confidence, p.confidence));
  return tenantConds;
}

export async function listSkillCandidates(
  p: ListSkillCandidatesParams,
  db: Executor,
): Promise<SkillCandidateView[]> {
  const limit = Math.min(Math.max(1, p.limit ?? 50), 500);
  const offset = Math.max(0, p.offset ?? 0);

  const rows = await db
    .select()
    .from(skillCandidates)
    .where(and(...listFilterConds(p)))
    .orderBy(desc(skillCandidates.created_at), desc(skillCandidates.id))
    .limit(limit)
    .offset(offset);

  const counts = await getEvidenceCounts(
    rows.map((r) => r.id),
    db,
  );
  return rows.map((r) => toView(r, counts.get(r.id) ?? 0));
}

export async function countSkillCandidates(
  p: ListSkillCandidatesParams,
  db: Executor,
): Promise<number> {
  const [row] = await db
    .select({ cnt: count() })
    .from(skillCandidates)
    .where(and(...listFilterConds(p)));
  return Number(row?.cnt ?? 0);
}

const OPEN_STATUSES: SkillCandidateStatus[] = ["proposed", "context"];

export async function getSkillCandidate(
  tenant_id: string,
  id: string,
  db: Executor,
): Promise<SkillCandidateView | null> {
  const rows = await db
    .select()
    .from(skillCandidates)
    .where(and(eq(skillCandidates.tenant_id, tenant_id), eq(skillCandidates.id, id)))
    .limit(1);
  if (!rows[0]) return null;
  const counts = await getEvidenceCounts([rows[0].id], db);
  return toView(rows[0], counts.get(rows[0].id) ?? 0);
}

interface SkillCandidateReviewSubject {
  id: string;
  title: string;
  status: SkillCandidateStatus;
  body: string;
  pattern_kind: string;
  tags: string[];
  review_digest: string;
}

export async function getSkillCandidatesForReview(
  tenant_id: string,
  ids: readonly string[],
  db: Executor,
): Promise<SkillCandidateReviewSubject[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(skillCandidates)
    .where(
      and(
        eq(skillCandidates.tenant_id, tenant_id),
        inArray(skillCandidates.id, [...ids]),
        notInArray(skillCandidates.pattern_kind, LEARNING_KINDS),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    body: row.body,
    pattern_kind: row.pattern_kind,
    tags: row.tags ?? [],
    review_digest: skillReviewDigest(row),
  }));
}

export async function getSkillCandidateEvidence(
  tenant_id: string,
  candidate_id: string,
  db: Executor,
): Promise<SkillCandidateEvidenceView[]> {
  const candidate = await getSkillCandidate(tenant_id, candidate_id, db);
  if (!candidate) return [];

  // tenant-filter:exempt — skill_candidate_evidence has no tenant_id column (FK-cascade to skill_candidates.id); the candidate above was already tenant-checked via getSkillCandidate
  const rows = await db
    .select()
    .from(skillCandidateEvidence)
    .where(eq(skillCandidateEvidence.skill_candidate_id, candidate_id))
    .orderBy(desc(skillCandidateEvidence.captured_at));

  return uniqueEvidence(rows).map((r) => ({
    id: r.id,
    skill_candidate_id: r.skill_candidate_id,
    execution_id: r.execution_id,
    patch_candidate_id: r.patch_candidate_id,
    evidence_type: r.evidence_type,
    summary: r.summary,
    captured_at: r.captured_at.toISOString(),
  }));
}

type UpsertCandidateResult = {
  action: "proposed" | "recorded" | "updated" | "skipped";
  candidate_id: string | null;
};

function signalDetails(signal: PatternSignal) {
  return {
    examples: signal.examples,
    best_practices: signal.best_practices,
    pitfalls: signal.pitfalls,
    doc_refs: signal.doc_refs,
    ...(signal.facts ? { facts: signal.facts } : {}),
  };
}

export async function upsertFromSignal(
  tenant_id: string,
  signal: PatternSignal,
  exec: Db,
): Promise<UpsertCandidateResult> {
  return await exec.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-candidates:${tenant_id}`}, 0))`,
    );
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
      const decision = decideSignalUpsert(row, signal);
      if (decision.kind === "skip") {
        log.skill.candidate.dedup({
          candidate_id: row.id,
          tenant_id,
          pattern_kind: signal.pattern_kind,
          reason: decision.reason,
        });
        return { action: "skipped" as const, candidate_id: row.id };
      }
      const updatedRows = await tx
        .update(skillCandidates)
        .set({
          confidence: signal.confidence,
          version: decision.version,
          evidence: signal.evidence,
          title: signal.title,
          body: signal.body,
          examples: signalDetails(signal),
          updated_at: sql`now()`,
        })
        .where(and(eq(skillCandidates.id, row.id), eq(skillCandidates.status, row.status)))
        .returning({ id: skillCandidates.id });
      if (updatedRows.length === 0) {
        log.skill.candidate.dedup({
          candidate_id: row.id,
          tenant_id,
          pattern_kind: signal.pattern_kind,
          reason: "concurrent_status_change",
        });
        return { action: "skipped" as const, candidate_id: row.id };
      }

      // tenant-filter:exempt — skill_candidate_evidence has no tenant_id column (FK-cascade to skill_candidates.id); `row` was loaded above with eq(skillCandidates.tenant_id, tenant_id)
      const existingEvidence = await tx
        .select()
        .from(skillCandidateEvidence)
        .where(eq(skillCandidateEvidence.skill_candidate_id, row.id));

      const newEvidence = mergeCandidateEvidence(
        existingEvidence,
        signal.evidence,
        MAX_EVIDENCE_PER_CANDIDATE,
      ).additions;
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
            version: decision.version,
            scope: signal.scope,
            connector_id: signal.connector_id ?? null,
          },
        },
        tx,
      );

      return { action: "updated" as const, candidate_id: row.id };
    }

    const insertDecision = decideSignalUpsert(null, signal);
    let supersededCount = 0;
    if (insertDecision.supersede_open) {
      const tenantSupersedeScope = [
        eq(skillCandidates.tenant_id, tenant_id),
        inArray(skillCandidates.status, OPEN_STATUSES),
        eq(skillCandidates.scope, signal.scope),
        eq(skillCandidates.pattern_kind, signal.pattern_kind),
        isNull(skillCandidates.endpoint_key),
      ];
      if (signal.workflow_id)
        tenantSupersedeScope.push(eq(skillCandidates.workflow_id, signal.workflow_id));
      else if (signal.connector_id)
        tenantSupersedeScope.push(eq(skillCandidates.connector_id, signal.connector_id));

      const stale = await tx
        .select({ id: skillCandidates.id })
        .from(skillCandidates)
        .where(and(...tenantSupersedeScope));
      supersededCount = stale.length;

      for (const s of stale) {
        await tx
          .update(skillCandidates)
          .set({ status: "superseded", updated_at: new Date() })
          .where(
            and(
              eq(skillCandidates.tenant_id, tenant_id),
              eq(skillCandidates.id, s.id),
              inArray(skillCandidates.status, OPEN_STATUSES),
            ),
          );
        await auditAwait(
          {
            tenant_id,
            actor_type: "system",
            action: AuditAction.SKILL_CANDIDATE_SUPERSEDED,
            resource_type: "skill_candidate",
            resource_id: s.id,
            result: "success",
            metadata: {
              superseded_by_fingerprint: signal.fingerprint,
              scope: signal.scope,
              connector_id: signal.connector_id ?? null,
            },
          },
          tx,
        );
      }
    }

    const proposer = actorIds(signal.proposer ?? null);
    const [row] = await tx
      .insert(skillCandidates)
      .values({
        tenant_id,
        scope: signal.scope,
        connector_id: signal.connector_id ?? null,
        endpoint_key: signal.endpoint_key ?? null,
        workflow_id: signal.workflow_id ?? null,
        pattern_kind: signal.pattern_kind,
        title: signal.title,
        body: signal.body,
        examples: signalDetails(signal),
        evidence: signal.evidence,
        confidence: signal.confidence,
        status: insertDecision.initial_status,
        fingerprint: signal.fingerprint,
        tags: signal.tags ?? [],
        proposed_by_user_id: proposer.user_id,
        proposed_by_system_account_id: proposer.system_account_id,
      })
      .returning();

    assertInsertRow(row, "skill_candidates");

    if (signal.evidence.length > 0) {
      await tx.insert(skillCandidateEvidence).values(
        mergeCandidateEvidence([], signal.evidence, MAX_EVIDENCE_PER_CANDIDATE).additions.map(
          (e) => ({
            skill_candidate_id: row.id,
            execution_id: e.execution_id ?? null,
            patch_candidate_id: e.patch_candidate_id ?? null,
            evidence_type: e.evidence_type,
            summary: e.summary,
          }),
        ),
      );
    }

    await auditAwait(
      {
        tenant_id,
        ...auditActor(signal.proposer ?? null),
        action:
          insertDecision.initial_status === "context"
            ? AuditAction.SKILL_CANDIDATE_CONTEXT_RECORDED
            : AuditAction.SKILL_CANDIDATE_PROPOSED,
        resource_type: "skill_candidate",
        resource_id: row.id,
        result: "success",
        metadata: {
          pattern_kind: signal.pattern_kind,
          confidence: signal.confidence,
          fingerprint: signal.fingerprint,
          scope: signal.scope,
          connector_id: signal.connector_id ?? null,
        },
      },
      tx,
    );

    const logged = {
      candidate_id: row.id,
      tenant_id,
      pattern_kind: signal.pattern_kind,
      confidence: signal.confidence,
      superseded_count: supersededCount,
    };
    if (insertDecision.initial_status === "context") {
      log.skill.candidate.contextRecorded(logged);
      return { action: "recorded" as const, candidate_id: row.id };
    }
    log.skill.candidate.proposed(logged);
    return { action: "proposed" as const, candidate_id: row.id };
  });
}

export async function runPatternAnalysis(
  params: { tenant_id: string },
  db: Db,
): Promise<AnalysisResult> {
  const [repairSignals, failureSignals, successSignals] = await Promise.all([
    detectRepairPatterns(params.tenant_id, db),
    detectFailurePatterns(params.tenant_id, db),
    detectSuccessPatterns(params.tenant_id, db),
  ]);
  const corrections = await collectCorrectionIntake(params.tenant_id, db);
  const effectiveness = await measureCorrectionEffectiveness(params.tenant_id, db);

  const allSignals = [...repairSignals, ...failureSignals, ...successSignals];
  let proposed = 0;
  let updated = 0;

  for (const signal of allSignals) {
    const result = await upsertFromSignal(params.tenant_id, signal, db);
    if (result.action === "proposed") proposed++;
    if (result.action === "updated") updated++;
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
    corrections_collected: corrections.collected,
    corrections_appended: corrections.evidence_appended,
    corrections_measured: effectiveness.measured,
  });

  return {
    candidates_proposed: proposed,
    candidates_updated: updated,
    patterns_checked: allSignals.length,
  };
}

export { approvalFailureOf } from "./core/review.ts";

interface ApproveSkillCandidateResult {
  candidate: SkillCandidateView;
  skill_id: string;
}

export async function approveSkillCandidate(
  p: ApproveSkillCandidateParams,
  db: Db,
): Promise<ApproveSkillCandidateResult | null> {
  const actor = auditActor(p.actor);
  const actor_id = actor.actor_id;

  const out = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-candidates:${p.tenant_id}`}, 0))`,
    );
    const rows = await tx
      .select()
      .from(skillCandidates)
      .where(
        and(
          eq(skillCandidates.tenant_id, p.tenant_id),
          eq(skillCandidates.id, p.candidate_id),
          eq(skillCandidates.status, "proposed"),
          notInArray(skillCandidates.pattern_kind, LEARNING_KINDS),
        ),
      )
      .for("update")
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const review = decideCandidateReview(
      {
        status: row.status,
        pattern_kind: row.pattern_kind,
        review_digest: skillReviewDigest(row),
      },
      {
        kind: "approve",
        ...(p.expected_review_digest ? { expected_review_digest: p.expected_review_digest } : {}),
      },
    );
    if (review.kind !== "approve") return null;
    const blob = (row.examples ?? {}) as Record<string, unknown>;

    await lockCatalogVocabulary(tx, p.tenant_id);
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
          ...(row.tags && row.tags.length > 0 ? { tags: row.tags } : {}),
          examples: (blob.examples as string[]) ?? [],
          best_practices: (blob.best_practices as string[]) ?? [],
          pitfalls: (blob.pitfalls as string[]) ?? [],
          doc_refs: (blob.doc_refs as string[]) ?? [],
        },
        ...actor,
      },
      tx,
    );
    const skill_id = skill.id;
    const promoted_active = skill.status === "active";

    const [updated] = await tx
      .update(skillCandidates)
      .set({
        status: "approved",
        promoted_skill_id: skill_id,
        updated_at: new Date(),
      })
      .where(
        and(eq(skillCandidates.tenant_id, p.tenant_id), eq(skillCandidates.id, p.candidate_id)),
      )
      .returning();

    const retired_skill_ids = promoted_active
      ? await retireReplacedConnectorSkills(tx, p.tenant_id, skill_id, actor_id, actor.actor_type)
      : [];

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...auditActor(p.actor),
        action: AuditAction.SKILL_CANDIDATE_APPROVED,
        resource_type: "skill_candidate",
        resource_id: p.candidate_id,
        result: "success",
        metadata: {
          pattern_kind: row.pattern_kind,
          promoted_skill_id: skill_id,
          ...(retired_skill_ids.length > 0 ? { retired_skill_ids } : {}),
        },
      },
      tx,
    );

    log.skill.candidate.approved({
      candidate_id: p.candidate_id,
      skill_id,
      pattern_kind: row.pattern_kind,
      actor_id,
    });

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
      skill_id,
      promotion_source: "auto-suggested" as const,
      lag_seconds,
    };
  });

  if (!out) return null;
  invalidateTenantState(p.tenant_id);

  recordLoopSkillCandidatePromoted({
    tenant_id: p.tenant_id,
    source: out.promotion_source,
    lag_seconds: out.lag_seconds,
  });

  return { candidate: out.candidate, skill_id: out.skill_id };
}

type RejectSkillCandidateOutcome =
  | { kind: "rejected" }
  | { kind: "not_found" }
  | { kind: "already_decided"; status: SkillCandidateStatus };

export async function rejectSkillCandidate(
  p: RejectSkillCandidateParams,
  db: Db,
): Promise<RejectSkillCandidateOutcome> {
  const outcome = await db.transaction(async (tx): Promise<RejectSkillCandidateOutcome> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-candidates:${p.tenant_id}`}, 0))`,
    );
    const rows = await tx
      .select({ id: skillCandidates.id, status: skillCandidates.status })
      .from(skillCandidates)
      .where(
        and(
          eq(skillCandidates.tenant_id, p.tenant_id),
          eq(skillCandidates.id, p.candidate_id),
          notInArray(skillCandidates.pattern_kind, LEARNING_KINDS),
        ),
      )
      .for("update")
      .limit(1);

    const row = rows[0];
    if (!row || row.status === "context") return { kind: "not_found" };
    if (row.status !== "proposed") return { kind: "already_decided", status: row.status };

    await tx
      .update(skillCandidates)
      .set({ status: "rejected", updated_at: new Date() })
      .where(
        and(
          eq(skillCandidates.tenant_id, p.tenant_id),
          eq(skillCandidates.id, p.candidate_id),
          eq(skillCandidates.status, "proposed"),
        ),
      );

    const actor_type = p.actor_type ?? (p.actor_id === null ? "system" : "unknown");

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type,
        actor_id: actor_type === "unknown" ? null : p.actor_id,
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

    return { kind: "rejected" };
  });
  if (outcome.kind === "rejected") invalidateTenantState(p.tenant_id);
  return outcome;
}
