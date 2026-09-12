import type { skillCandidates } from "../db/schema/skills.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import type { SkillCandidateView } from "./types.ts";

/** Convert a DB row to a view. evidence_count defaults to 0 — callers that
 *  need the real count should query the relational evidence table. */
export function skillReviewDigest(row: typeof skillCandidates.$inferSelect): string {
  return workflowJsonDigest({
    tenant: row.tenant_id,
    id: row.id,
    scope: row.scope,
    connector: row.connector_id,
    endpoint: row.endpoint_key,
    workflow: row.workflow_id,
    title: row.title,
    body: row.body,
    examples: row.examples,
    tags: row.tags,
  });
}

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
    evidence_count: evidenceCount,
    confidence: row.confidence,
    status: row.status,
    promoted_skill_id: row.promoted_skill_id,
    reviewable:
      row.status === "proposed" &&
      !["failure_pattern", "authoring_capability"].includes(row.pattern_kind),
    review_digest: skillReviewDigest(row),
    fingerprint: row.fingerprint,
    version: row.version,
    tags: row.tags ?? [],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
