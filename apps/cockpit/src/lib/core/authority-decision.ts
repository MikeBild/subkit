import type { components } from "@cli-core/engine-api/openapi";
import { observedAuthorityState } from "@shared/workflow-automation.ts";

type WorkflowAuthority = components["schemas"]["WorkflowExecutionAuthority"];
type WorkflowAuthorityPreview = components["schemas"]["WorkflowAuthorityPreview"];

export type AuthorityReviewIdentity = {
  workflowId: string;
  versionId: string;
  environment: "dev" | "prod";
};

export function acceptReview(
  latestToken: number,
  token: number,
  expected: AuthorityReviewIdentity,
  review: WorkflowAuthorityPreview,
): "accept" | "stale" | "mismatch" {
  if (token !== latestToken) return "stale";
  if (
    review.manifest.workflow_id !== expected.workflowId ||
    review.manifest.workflow_version_id !== expected.versionId ||
    review.manifest.execution_environment !== expected.environment
  )
    return "mismatch";
  return "accept";
}

export function authorityGrantInput(
  preview: WorkflowAuthorityPreview,
  expected: AuthorityReviewIdentity,
  runs: string | null,
  hours: string | null,
  now: number,
) {
  const maxRuns = runs === null ? null : Number(runs);
  const duration = hours === null ? null : Number(hours);
  const from = Date.parse(preview.suggested_bounds.valid_from);
  const until = duration === null ? null : from + duration * 3_600_000;
  if (
    !preview.eligible_for_repeated_runs ||
    preview.manifest.workflow_id !== expected.workflowId ||
    preview.manifest.workflow_version_id !== expected.versionId ||
    preview.manifest.execution_environment !== expected.environment ||
    (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 10_000)) ||
    (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 744)) ||
    !Number.isFinite(from) ||
    (until !== null && (!Number.isFinite(until) || until <= now)) ||
    preview.execution_shape.requests.some(
      (request) => request.request_review_truncated || request.opaque_payload_omitted,
    )
  )
    return null;
  return {
    workflow_version_id: preview.manifest.workflow_version_id,
    execution_environment: preview.manifest.execution_environment,
    expected_manifest_digest: preview.digest,
    valid_from: preview.suggested_bounds.valid_from,
    valid_until: until === null ? null : new Date(until).toISOString(),
    max_runs: maxRuns,
  };
}

export function authorityGrantInputUntil(
  preview: WorkflowAuthorityPreview,
  expected: AuthorityReviewIdentity,
  validUntil: string | null,
  maxRuns: number | null,
  now: number,
) {
  const base = authorityGrantInput(preview, expected, null, null, now);
  if (!base) return null;
  if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 10_000))
    return null;
  if (validUntil !== null) {
    const until = Date.parse(validUntil);
    if (!Number.isFinite(until) || until <= now || until <= Date.parse(base.valid_from))
      return null;
  }
  return { ...base, valid_until: validUntil, max_runs: maxRuns };
}

const DAY_MS = 86_400_000;

export function untilRevokedOffer(
  authority: WorkflowAuthority,
  now: number,
  canWrite: boolean,
): { days: number | null } | null {
  if (!canWrite || authority.revoked_at !== null) return null;
  if (authority.valid_until === null && authority.max_runs === null) return null;
  if (observedAuthorityState(authority, now) !== "approved") return null;
  return {
    days:
      authority.valid_until === null
        ? null
        : Math.max(1, Math.ceil((Date.parse(authority.valid_until) - now) / DAY_MS)),
  };
}
