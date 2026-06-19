import { z } from "@hono/zod-openapi";

// ----- enums -----------------------------------------------------------------

export const SkillCandidateStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);
export const SkillCandidateConfidenceSchema = z.enum(["low", "medium", "high"]);
export const SkillCandidatePatternSchema = z.enum([
  "repair_pattern",
  "failure_pattern",
  "success_pattern",
  "chained_workflow_pattern",
]);

export type SkillCandidateStatus = z.infer<typeof SkillCandidateStatusSchema>;
export type SkillCandidateConfidence = z.infer<typeof SkillCandidateConfidenceSchema>;
export type SkillCandidatePattern = z.infer<typeof SkillCandidatePatternSchema>;

// ----- view types ------------------------------------------------------------

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
    evidence_count: z.number().int(),
    confidence: SkillCandidateConfidenceSchema,
    status: SkillCandidateStatusSchema,
    promoted_skill_id: z.string().nullable(),
    fingerprint: z.string(),
    version: z.number().int(),
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

// ----- pattern detection types -----------------------------------------------

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
  fingerprint: string;
  confidence: SkillCandidateConfidence;
  evidence: Array<{
    execution_id?: string;
    patch_candidate_id?: string;
    evidence_type: string;
    summary: string;
  }>;
}

// ----- confidence scoring ----------------------------------------------------

export function computeConfidence(
  evidenceCount: number,
  consistencyRatio: number,
): SkillCandidateConfidence {
  if (evidenceCount >= 8 && consistencyRatio >= 0.9) return "high";
  if (evidenceCount >= 5 && consistencyRatio >= 0.8) return "medium";
  return "low";
}

// ----- service params --------------------------------------------------------

export interface ListSkillCandidatesParams {
  tenant_id: string;
  status?: SkillCandidateStatus;
  scope?: "global" | "connector" | "workflow";
  connector_id?: string;
  workflow_id?: string;
  pattern_kind?: SkillCandidatePattern;
  confidence?: SkillCandidateConfidence;
  limit?: number;
  offset?: number;
}

export interface ApproveSkillCandidateParams {
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
