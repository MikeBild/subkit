import { actorFromColumns } from "../audit/actor.ts";
import type { skillCandidates } from "../db/schema/skills.ts";
import { skillReviewDigest } from "./core/review.ts";

export { skillReviewDigest } from "./core/review.ts";

import { SkillCandidateFactsSchema, type SkillCandidateView } from "./types.ts";

export { initialCandidateStatus } from "./core/candidate-decision.ts";

export function toView(
  row: typeof skillCandidates.$inferSelect,
  evidenceCount = 0,
): SkillCandidateView {
  const blob = (row.examples ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    scope: row.scope,
    connector_id: row.connector_id,
    endpoint_key: row.endpoint_key,
    workflow_id: row.workflow_id,
    pattern_kind: row.pattern_kind,
    title: row.title,
    body: row.body,
    examples: (blob.examples as string[]) ?? [],
    best_practices: (blob.best_practices as string[]) ?? [],
    pitfalls: (blob.pitfalls as string[]) ?? [],
    doc_refs: (blob.doc_refs as string[]) ?? [],
    facts: SkillCandidateFactsSchema.safeParse(blob.facts).data ?? null,
    evidence_count: evidenceCount,
    confidence: row.confidence,
    status: row.status,
    promoted_skill_id: row.promoted_skill_id,
    reviewable: row.status === "proposed",
    review_digest: skillReviewDigest(row),
    fingerprint: row.fingerprint,
    version: row.version,
    tags: row.tags ?? [],
    proposed_by: actorFromColumns(row.proposed_by_user_id, row.proposed_by_system_account_id),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
