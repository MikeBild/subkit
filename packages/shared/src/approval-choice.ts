import type { EnvironmentDecision, ReviewEnvironment } from "./workflow-automation.ts";

export const APPROVAL_ENVIRONMENTS = ["dev", "prod"] as const;

export const ENVIRONMENT_BLOCK_CODES = [
  "connector_missing",
  "connector_without_sign_in",
  "connector_needs_sign_in_again",
  "connector_switched_off",
] as const;
export type EnvironmentBlockCode = (typeof ENVIRONMENT_BLOCK_CODES)[number];

export const ENVIRONMENT_RECOMMENDATION_REASONS = [
  "only_possible",
  "schedule",
  "inbound_hook",
  "existing_approval",
  "started_manually",
  "none_possible",
] as const;
export type EnvironmentRecommendationReason = (typeof ENVIRONMENT_RECOMMENDATION_REASONS)[number];

export interface EnvironmentBlock {
  code: EnvironmentBlockCode;
  step_id: string;
  connector_id: string | null;
  connector_name: string | null;
}

export interface EnvironmentAssessment {
  possible: boolean;
  reasons: EnvironmentBlock[];
}

export type EnvironmentAssessments = Record<ReviewEnvironment, EnvironmentAssessment>;

export interface EnvironmentRecommendation {
  environment: ReviewEnvironment | null;
  reason: EnvironmentRecommendationReason;
}

export interface ApprovalPreviewLike {
  environments: EnvironmentAssessments;
  recommended_environment: EnvironmentRecommendation;
}

export type ApprovalChoiceReason = Exclude<EnvironmentRecommendationReason, "none_possible">;

export type EnvironmentBlockIn = EnvironmentBlock & { environment: ReviewEnvironment };

export type ApprovalChoice =
  | { kind: "single"; environment: ReviewEnvironment; reason: ApprovalChoiceReason }
  | {
      kind: "choice";
      recommended: ReviewEnvironment;
      options: Array<{ environment: ReviewEnvironment; possible: boolean }>;
    }
  | { kind: "none"; reasons: EnvironmentBlockIn[] };

export type ApprovalRemedy = {
  kind: "open_connector" | "sign_in_again";
  environment: ReviewEnvironment;
  step_id: string;
  connector_id: string | null;
};

const other = (environment: ReviewEnvironment): ReviewEnvironment =>
  environment === "dev" ? "prod" : "dev";

export function recommendEnvironment(
  context: EnvironmentDecision | null,
  environments: EnvironmentAssessments,
): EnvironmentRecommendation {
  const possible = APPROVAL_ENVIRONMENTS.filter(
    (environment) => environments[environment].possible,
  );
  if (possible.length === 0) return { environment: null, reason: "none_possible" };
  if (context) {
    if (environments[context.environment].possible)
      return { environment: context.environment, reason: context.reason };
    return { environment: other(context.environment), reason: "only_possible" };
  }
  const [only] = possible;
  if (possible.length === 1 && only) return { environment: only, reason: "only_possible" };
  return { environment: "dev", reason: "started_manually" };
}

export function approvalChoice(
  preview: Partial<ApprovalPreviewLike>,
  requested: ReviewEnvironment = "dev",
): ApprovalChoice {
  const { environments, recommended_environment: recommended } = preview;
  if (!environments || !recommended)
    return {
      kind: "choice",
      recommended: requested,
      options: APPROVAL_ENVIRONMENTS.map((each) => ({ environment: each, possible: true })),
    };
  const { environment, reason } = recommended;
  if (environment === null || reason === "none_possible" || !environments[environment]?.possible)
    return {
      kind: "none",
      reasons: APPROVAL_ENVIRONMENTS.flatMap((each) =>
        (environments[each]?.reasons ?? []).map((block) => ({ ...block, environment: each })),
      ),
    };
  const bothPossible = APPROVAL_ENVIRONMENTS.every((each) => environments[each]?.possible);
  if (bothPossible && reason === "started_manually")
    return {
      kind: "choice",
      recommended: environment,
      options: APPROVAL_ENVIRONMENTS.map((each) => ({
        environment: each,
        possible: Boolean(environments[each]?.possible),
      })),
    };
  return { kind: "single", environment, reason };
}

const REMEDY_ORDER: readonly EnvironmentBlockCode[] = [
  "connector_needs_sign_in_again",
  "connector_without_sign_in",
  "connector_switched_off",
  "connector_missing",
];

export function approvalRemedy(
  reasons: readonly EnvironmentBlockIn[],
  preferred: ReviewEnvironment | null = null,
): ApprovalRemedy | null {
  if (reasons.length === 0) return null;
  const count = (environment: ReviewEnvironment) =>
    reasons.filter((reason) => reason.environment === environment).length;
  const present = APPROVAL_ENVIRONMENTS.filter((environment) => count(environment) > 0);
  const target =
    preferred && count(preferred) > 0
      ? preferred
      : [...present].sort((a, b) => count(a) - count(b))[0];
  const candidates = reasons.filter((reason) => reason.environment === target);
  const [picked] = [...candidates].sort(
    (a, b) => REMEDY_ORDER.indexOf(a.code) - REMEDY_ORDER.indexOf(b.code),
  );
  if (!picked) return null;
  return {
    kind: picked.code === "connector_needs_sign_in_again" ? "sign_in_again" : "open_connector",
    environment: picked.environment,
    step_id: picked.step_id,
    connector_id: picked.connector_id,
  };
}
