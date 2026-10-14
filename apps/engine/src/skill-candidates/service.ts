import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { actorFromColumns, actorIds, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { patchCandidates } from "../db/schema/executions.ts";
import { skillCandidateEvidence, skillCandidates } from "../db/schema/skills.ts";
import {
  appendLearningToKnowledge,
  getKnowledgeSource,
  learningsTarget,
} from "../knowledge/index.ts";
import { log } from "../logging/logger.ts";
import {
  recordLoopPatchToSkillCandidate,
  recordLoopSkillCandidatePromoted,
} from "../observability/instrumentation.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { createSkill, retireReplacedConnectorSkills } from "../skills/service.ts";
import { now } from "../utils/clock.ts";
import { initialCandidateStatus, skillReviewDigest, toView } from "./candidate-view.ts";
import {
  detectFailurePatterns,
  detectRepairPatterns,
  detectSuccessPatterns,
} from "./detectors/index.ts";
import { evidenceIdentity, uniqueEvidence } from "./evidence-identity.ts";
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

export async function knowledgeSourceCandidateIds(
  tenant_id: string,
  knowledge_source_id: string,
  exec?: Executor,
): Promise<string[] | null> {
  const db = exec ?? getDb();
  const source = await getKnowledgeSource(tenant_id, knowledge_source_id, db);
  if (!source) return null;
  if (source.source_type !== "inline") return [];
  const candidates = await db
    .select({ id: skillCandidates.id, tags: skillCandidates.tags })
    .from(skillCandidates)
    .where(
      and(
        eq(skillCandidates.tenant_id, tenant_id),
        eq(skillCandidates.pattern_kind, "knowledge_learning"),
      ),
    );
  return candidates
    .filter((candidate) => learningsTarget(candidate.tags ?? []).slug === source.slug)
    .map((candidate) => candidate.id);
}

export async function listSkillCandidates(
  p: ListSkillCandidatesParams,
  exec?: Executor,
): Promise<SkillCandidateView[]> {
  const db = exec ?? getDb();
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
  exec?: Executor,
): Promise<number> {
  const db = exec ?? getDb();
  const [row] = await db
    .select({ cnt: count() })
    .from(skillCandidates)
    .where(and(...listFilterConds(p)));
  return Number(row?.cnt ?? 0);
}

export const LIST_PROPOSED_FOR_AUTHORING_CAP = 8;

const OPEN_STATUSES: SkillCandidateStatus[] = ["proposed", "context"];

const UNREVIEWED_PROMPT_EXCLUDED_KINDS: ReadonlySet<string> = new Set(["connector_capability"]);

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
    listSkillCandidates({ tenant_id, statuses: OPEN_STATUSES, scope: "global", limit: 500 }, db),
    scope_hints.connector_id
      ? listSkillCandidates(
          {
            tenant_id,
            statuses: OPEN_STATUSES,
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
            statuses: OPEN_STATUSES,
            scope: "workflow",
            workflow_id: scope_hints.workflow_id,
            limit: 500,
          },
          db,
        )
      : Promise.resolve<SkillCandidateView[]>([]),
  ]);

  const merged: SkillCandidateView[] = [...globalRows, ...connectorRows, ...workflowRows].filter(
    (c) => !UNREVIEWED_PROMPT_EXCLUDED_KINDS.has(c.pattern_kind),
  );

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
  } catch {}
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

export interface CreateCandidateFromAuthoringParams {
  tenant_id: string;
  title: string;
  body: string;
  scope: "global" | "connector" | "workflow";
  connector_id?: string;
  workflow_id?: string;
  examples?: string[];
  best_practices?: string[];
  pitfalls?: string[];
  doc_refs?: string[];
  tags?: string[];
  evidence_summary: string;
  db: Db;
}

export type UpsertCandidateResult = {
  action: "proposed" | "recorded" | "updated" | "skipped";
  candidate_id: string | null;
};

export async function createCandidateFromAuthoring(
  p: CreateCandidateFromAuthoringParams,
): Promise<UpsertCandidateResult> {
  const normalizedTitle = p.title.toLowerCase().replace(/\s+/g, " ").trim();
  if (p.connector_id && p.workflow_id) {
    throw new Error("proposal cannot set both connector_id and workflow_id");
  }
  let entity: string;
  if (p.scope === "connector") {
    if (!p.connector_id) throw new Error("connector-scoped proposal requires connector_id");
    entity = p.connector_id;
  } else if (p.scope === "workflow") {
    if (!p.workflow_id) throw new Error("workflow-scoped proposal requires workflow_id");
    entity = p.workflow_id;
  } else {
    if (p.connector_id || p.workflow_id) {
      throw new Error("global proposal must not set connector_id or workflow_id");
    }
    entity = "global";
  }
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        body: p.body,
        examples: p.examples ?? [],
        best_practices: p.best_practices ?? [],
        pitfalls: p.pitfalls ?? [],
        doc_refs: p.doc_refs ?? [],
        tags: p.tags ?? [],
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const fingerprint = createHash("sha256")
    .update(`authoring_skill:${p.scope}:${entity}:${normalizedTitle}:${contentHash}`)
    .digest("hex");
  const result = await upsertFromSignal(
    p.tenant_id,
    {
      pattern_kind: "session_learning",
      scope: p.scope,
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
      title: p.title,
      body: p.body,
      examples: p.examples ?? [],
      best_practices: p.best_practices ?? [],
      pitfalls: p.pitfalls ?? [],
      doc_refs: p.doc_refs ?? [],
      fingerprint,
      confidence: "high",
      ...(p.tags && p.tags.length > 0 ? { tags: p.tags } : {}),
      evidence: [{ evidence_type: "conversation", summary: p.evidence_summary.slice(0, 2_000) }],
    },
    p.db,
  );

  if (result.action !== "skipped" && result.candidate_id) {
    const staleConds = [
      eq(skillCandidates.pattern_kind, "session_learning"),
      eq(skillCandidates.status, "proposed"),
      eq(skillCandidates.scope, p.scope),
      sql`btrim(lower(regexp_replace(${skillCandidates.title}, '\\s+', ' ', 'g'))) = ${normalizedTitle}`,
      sql`${skillCandidates.id} <> ${result.candidate_id}`,
      sql`(${skillCandidates.updated_at}, ${skillCandidates.id}) < (SELECT sc.updated_at, sc.id FROM skill_candidates sc WHERE sc.id = ${result.candidate_id})`,
    ];
    if (p.connector_id) staleConds.push(eq(skillCandidates.connector_id, p.connector_id));
    if (p.workflow_id) staleConds.push(eq(skillCandidates.workflow_id, p.workflow_id));
    const stale = await p.db
      .select({ id: skillCandidates.id })
      .from(skillCandidates)
      .where(and(eq(skillCandidates.tenant_id, p.tenant_id), ...staleConds));
    for (const s of stale) {
      const flipped = await p.db
        .update(skillCandidates)
        .set({ status: "superseded", updated_at: sql`now()` })
        .where(
          and(
            eq(skillCandidates.tenant_id, p.tenant_id),
            eq(skillCandidates.id, s.id),
            eq(skillCandidates.status, "proposed"),
          ),
        )
        .returning({ id: skillCandidates.id });
      if (flipped.length === 0) continue;
      await auditAwait(
        {
          tenant_id: p.tenant_id,
          actor_type: "system",
          action: AuditAction.SKILL_CANDIDATE_SUPERSEDED,
          resource_type: "skill_candidate",
          resource_id: s.id,
          result: "success",
          metadata: {
            superseded_by_fingerprint: fingerprint,
            scope: p.scope,
            connector_id: p.connector_id ?? null,
            reason: "authoring_revision",
          },
        },
        p.db,
      );
    }
  }
  return result;
}

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
  const status = initialCandidateStatus(signal.pattern_kind);
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
      const learning = LEARNING_PATTERN_KINDS.has(signal.pattern_kind);
      const reviveSessionLearning = row.status === "superseded" && learning;
      if (!reviveSessionLearning && (row.status === "rejected" || row.status === "superseded")) {
        log.skill.candidate.dedup({
          candidate_id: row.id,
          tenant_id,
          pattern_kind: signal.pattern_kind,
          reason: row.status,
        });
        return { action: "skipped" as const, candidate_id: row.id };
      }
      if (row.status === "approved") {
        log.skill.candidate.dedup({
          candidate_id: row.id,
          tenant_id,
          pattern_kind: signal.pattern_kind,
          reason: "approved",
        });
        return { action: "skipped" as const, candidate_id: row.id };
      }
      const updatedRows = await tx
        .update(skillCandidates)
        .set({
          confidence: signal.confidence,
          version: row.version + 1,
          evidence: signal.evidence,
          title: signal.title,
          body: signal.body,
          examples: signalDetails(signal),
          updated_at: sql`now()`,
          ...(learning
            ? {
                status: "proposed" as const,
                title: signal.title,
                body: signal.body,
                examples: signalDetails(signal),
                ...(signal.tags && signal.tags.length > 0 ? { tags: signal.tags } : {}),
              }
            : {}),
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

      const remaining = MAX_EVIDENCE_PER_CANDIDATE - existingEvidence.length;
      if (remaining > 0) {
        const existingKeys = new Set(existingEvidence.map(evidenceIdentity));
        const newEvidence = uniqueEvidence(signal.evidence)
          .filter((e) => !existingKeys.has(evidenceIdentity(e)))
          .slice(0, remaining);
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
            scope: signal.scope,
            connector_id: signal.connector_id ?? null,
            ...(reviveSessionLearning ? { reason: "revived_from_superseded" } : {}),
          },
        },
        tx,
      );

      return { action: "updated" as const, candidate_id: row.id };
    }

    let supersededCount = 0;
    if (!signal.endpoint_key && !LEARNING_PATTERN_KINDS.has(signal.pattern_kind)) {
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
        status,
        fingerprint: signal.fingerprint,
        tags: signal.tags ?? [],
        proposed_by_user_id: proposer.user_id,
        proposed_by_system_account_id: proposer.system_account_id,
      })
      .returning();

    assertInsertRow(row, "skill_candidates");

    if (signal.evidence.length > 0) {
      await tx.insert(skillCandidateEvidence).values(
        uniqueEvidence(signal.evidence)
          .slice(0, MAX_EVIDENCE_PER_CANDIDATE)
          .map((e) => ({
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
        ...auditActor(signal.proposer ?? null),
        action:
          status === "context"
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
    if (status === "context") {
      log.skill.candidate.contextRecorded(logged);
      return { action: "recorded" as const, candidate_id: row.id };
    }
    log.skill.candidate.proposed(logged);
    return { action: "proposed" as const, candidate_id: row.id };
  });
}

export async function runPatternAnalysis(
  params: { tenant_id: string },
  exec?: Db,
): Promise<AnalysisResult> {
  const db = exec ?? (getDb() as Db);

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

export class KnowledgeWriteNotAllowedError extends Error {
  readonly code = "knowledge_write_required";
  constructor() {
    super("approving a fact writes knowledge and needs knowledge:write");
    this.name = "KnowledgeWriteNotAllowedError";
  }
}

export interface ApprovedKnowledge {
  knowledge_source_id: string;
  slug: string;
  version: number | null;
}

export interface ApproveSkillCandidateResult {
  candidate: SkillCandidateView;
  skill_id: string | null;
  knowledge: ApprovedKnowledge | null;
}

export async function approveSkillCandidate(
  p: ApproveSkillCandidateParams,
  exec?: Db,
): Promise<ApproveSkillCandidateResult | null> {
  const db = exec ?? (getDb() as Db);
  const actor_id = p.actor?.id ?? null;

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
        ),
      )
      .for("update")
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (p.expected_review_digest && p.expected_review_digest !== skillReviewDigest(row))
      return null;
    const blob = (row.examples ?? {}) as Record<string, unknown>;

    let skill_id: string | null = null;
    let promoted_active = false;
    let knowledge: (ApprovedKnowledge & { finish(db: Executor): void }) | null = null;
    if (row.pattern_kind === "knowledge_learning") {
      if (!p.may_write_knowledge) throw new KnowledgeWriteNotAllowedError();
      knowledge = await appendLearningToKnowledge(tx, {
        tenant_id: p.tenant_id,
        title: p.overrides?.title ?? row.title,
        body: p.overrides?.body ?? row.body,
        tags: row.tags ?? [],
        approver: p.actor,
        proposer: actorFromColumns(row.proposed_by_user_id, row.proposed_by_system_account_id),
      });
    } else {
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
          actor_id,
        },
        tx,
      );
      skill_id = skill.id;
      promoted_active = skill.status === "active";
    }

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

    const retired_skill_ids =
      skill_id && promoted_active
        ? await retireReplacedConnectorSkills(tx, p.tenant_id, skill_id, actor_id)
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
          ...(skill_id ? { promoted_skill_id: skill_id } : {}),
          ...(knowledge
            ? {
                knowledge_source_id: knowledge.knowledge_source_id,
                knowledge_version: knowledge.version,
              }
            : {}),
          ...(retired_skill_ids.length > 0 ? { retired_skill_ids } : {}),
        },
      },
      tx,
    );

    log.skill.candidate.approved({
      candidate_id: p.candidate_id,
      skill_id,
      knowledge_source_id: knowledge?.knowledge_source_id ?? null,
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
      knowledge,
      promotion_source: "auto-suggested" as const,
      lag_seconds,
    };
  });

  if (!out) return null;
  out.knowledge?.finish(db);
  invalidateTenantState(p.tenant_id);

  recordLoopSkillCandidatePromoted({
    tenant_id: p.tenant_id,
    source: out.promotion_source,
    lag_seconds: out.lag_seconds,
  });

  return {
    candidate: out.candidate,
    skill_id: out.skill_id,
    knowledge: out.knowledge
      ? {
          knowledge_source_id: out.knowledge.knowledge_source_id,
          slug: out.knowledge.slug,
          version: out.knowledge.version,
        }
      : null,
  };
}

export async function rejectSkillCandidate(
  p: RejectSkillCandidateParams,
  exec?: Db,
): Promise<boolean> {
  const db = exec ?? (getDb() as Db);

  const rejected = await db.transaction(async (tx) => {
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

    return true;
  });
  if (rejected) invalidateTenantState(p.tenant_id);
  return rejected;
}
