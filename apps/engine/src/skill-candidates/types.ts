import { z } from "@hono/zod-openapi";
import { PREVIEW_CLASSIFICATIONS } from "../execution/classify.ts";

export const SkillCandidateStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "context",
]);
export const SkillCandidateConfidenceSchema = z.enum(["low", "medium", "high"]);
export const SkillCandidatePatternSchema = z.enum([
  "repair_pattern",
  "failure_pattern",
  "success_pattern",
  "chained_workflow_pattern",
  "authoring_capability",
  "session_learning",
  "connector_capability",
]);

export type SkillCandidateStatus = z.infer<typeof SkillCandidateStatusSchema>;
export type SkillCandidateConfidence = z.infer<typeof SkillCandidateConfidenceSchema>;
export type SkillCandidatePattern = z.infer<typeof SkillCandidatePatternSchema>;

export const WorkflowCapabilityFactsSchema = z
  .object({
    kind: z.literal("workflow_capability"),
    inputs: z.array(
      z.object({ name: z.string(), type: z.string(), required: z.boolean() }).strict(),
    ),
    output_fields: z.array(z.string()).nullable(),
    key_paths: z.array(z.string()),
    connector_ids: z.array(z.string()),
    steps: z.array(z.object({ id: z.string(), kind: z.string() }).strict()),
    draft_version_id: z.string().nullable(),
  })
  .strict()
  .openapi("WorkflowCapabilityFacts");

export const RecurringFailureFactsSchema = z
  .object({
    kind: z.literal("recurring_failure"),
    step_key: z.string(),
    error_kind: z.string(),
    cause_class: z.enum(PREVIEW_CLASSIFICATIONS),
    count: z.number().int().nonnegative(),
    lookback_days: z.number().int().positive(),
  })
  .strict()
  .openapi("RecurringFailureFacts");

export const SkillCandidateFactsSchema = z
  .discriminatedUnion("kind", [WorkflowCapabilityFactsSchema, RecurringFailureFactsSchema])
  .describe(
    "What a drafting-context note states, as structured facts. Absent for candidates whose knowledge is prose only.",
  )
  .openapi("SkillCandidateFacts");

export type WorkflowCapabilityFacts = z.infer<typeof WorkflowCapabilityFactsSchema>;
export type RecurringFailureFacts = z.infer<typeof RecurringFailureFactsSchema>;
export type SkillCandidateFacts = z.infer<typeof SkillCandidateFactsSchema>;

export const SkillCandidateSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    scope: z.enum(["global", "connector", "workflow"]),
    connector_id: z.string().nullable(),
    endpoint_key: z.string().nullable(),
    workflow_id: z.string().nullable(),
    pattern_kind: SkillCandidatePatternSchema,
    title: z.string(),
    body: z.string(),
    examples: z.array(z.string()).default([]),
    best_practices: z.array(z.string()).default([]),
    pitfalls: z.array(z.string()).default([]),
    doc_refs: z.array(z.string()).default([]),
    facts: SkillCandidateFactsSchema.nullable(),
    evidence_count: z.number().int(),
    confidence: SkillCandidateConfidenceSchema,
    status: SkillCandidateStatusSchema,
    promoted_skill_id: z.string().nullable(),
    reviewable: z.boolean().optional(),
    review_digest: z.string().optional(),
    fingerprint: z.string(),
    version: z.number().int(),
    tags: z.array(z.string()).default([]),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("SkillCandidate");

export type SkillCandidateView = z.infer<typeof SkillCandidateSchema>;

export const SkillCandidateEvidenceSchema = z
  .object({
    id: z.string(),
    skill_candidate_id: z.string(),
    execution_id: z.string().nullable(),
    patch_candidate_id: z.string().nullable(),
    evidence_type: z.string(),
    summary: z.string(),
    captured_at: z.string(),
  })
  .openapi("SkillCandidateEvidence");

export type SkillCandidateEvidenceView = z.infer<typeof SkillCandidateEvidenceSchema>;

export interface PatternSignal {
  pattern_kind: SkillCandidatePattern;
  scope: "global" | "connector" | "workflow";
  connector_id?: string;
  endpoint_key?: string;
  workflow_id?: string;
  title: string;
  body: string;
  examples: string[];
  best_practices: string[];
  pitfalls: string[];
  doc_refs: string[];
  facts?: SkillCandidateFacts;
  fingerprint: string;
  confidence: SkillCandidateConfidence;
  tags?: string[];
  evidence: Array<{
    execution_id?: string;
    patch_candidate_id?: string;
    evidence_type: string;
    summary: string;
  }>;
}

export function computeConfidence(
  evidenceCount: number,
  consistencyRatio: number,
): SkillCandidateConfidence {
  if (evidenceCount >= 8 && consistencyRatio >= 0.9) return "high";
  if (evidenceCount >= 5 && consistencyRatio >= 0.8) return "medium";
  return "low";
}

export interface ListSkillCandidatesParams {
  tenant_id: string;
  status?: SkillCandidateStatus;
  statuses?: SkillCandidateStatus[];
  scope?: "global" | "connector" | "workflow";
  connector_id?: string;
  workflow_id?: string;
  pattern_kind?: SkillCandidatePattern;
  confidence?: SkillCandidateConfidence;
  limit?: number;
  offset?: number;
}

export interface ApproveSkillCandidateParams {
  expected_review_digest?: string;
  tenant_id: string;
  candidate_id: string;
  actor_id: string | null;
  overrides?:
    | {
        title?: string | undefined;
        body?: string | undefined;
        status?: "draft" | "active" | undefined;
      }
    | undefined;
}

export interface RejectSkillCandidateParams {
  tenant_id: string;
  candidate_id: string;
  actor_id: string | null;
  reason?: string;
}

export interface AnalysisResult {
  candidates_proposed: number;
  candidates_updated: number;
  patterns_checked: number;
}
