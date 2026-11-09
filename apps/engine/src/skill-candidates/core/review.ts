import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { LEARNING_PATTERN_KINDS } from "./candidate-decision.ts";

export interface CandidateReviewFacts {
  readonly tenant_id: string;
  readonly id: string;
  readonly scope: string;
  readonly connector_id: string | null;
  readonly endpoint_key: string | null;
  readonly workflow_id: string | null;
  readonly title: string;
  readonly body: string;
  readonly examples: unknown;
  readonly tags: readonly string[] | null;
}

export function skillReviewDigest(row: CandidateReviewFacts): string {
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

export type CandidateReviewDecision =
  | Readonly<{ kind: "approve" | "reject" }>
  | Readonly<{ kind: "not_found" | "already_decided" | "changed_since_review" }>;

export function decideCandidateReview(
  current: Readonly<{
    status: string;
    pattern_kind: string;
    review_digest: string;
  }> | null,
  command: Readonly<{ kind: "approve" | "reject"; expected_review_digest?: string }>,
): CandidateReviewDecision {
  if (!current || approvalFailureOf(current) === "not_found") return { kind: "not_found" };
  if (current.status !== "proposed") return { kind: "already_decided" };
  if (
    command.kind === "approve" &&
    command.expected_review_digest !== undefined &&
    command.expected_review_digest !== current.review_digest
  )
    return { kind: "changed_since_review" };
  return { kind: command.kind };
}

type SkillCandidateApprovalFailure = "not_found" | "already_decided" | "changed_since_review";

export function approvalFailureOf(
  current: Readonly<{ status: string; pattern_kind: string }> | null,
): SkillCandidateApprovalFailure {
  if (
    !current ||
    current.status === "context" ||
    (LEARNING_PATTERN_KINDS as readonly string[]).includes(current.pattern_kind)
  )
    return "not_found";
  return current.status === "proposed" ? "changed_since_review" : "already_decided";
}
