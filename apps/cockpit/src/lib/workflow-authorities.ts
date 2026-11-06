import type { components } from "@cli-core/engine-api/openapi";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
import { shortIdentifier } from "@/pages/audit-model";

export type WorkflowAuthority = components["schemas"]["WorkflowExecutionAuthority"];
export type WorkflowAuthorityList = components["schemas"]["WorkflowExecutionAuthorityList"];
export type WorkflowAuthorityPreview = components["schemas"]["WorkflowAuthorityPreview"];

type AuthorityReviewIdentity = {
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
  expected: { workflowId: string; versionId: string; environment: "dev" | "prod" },
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

export const AUTHORITY_STATE_KEYS = {
  approved: "authority.state.approved",
  not_yet_valid: "authority.state.notYetValid",
  expired: "authority.state.expired",
  revoked: "authority.state.revoked",
  superseded: "authority.state.superseded",
  exhausted: "authority.state.exhausted",
  invalidated: "authority.state.invalidated",
  unavailable: "authority.state.unavailable",
} satisfies Record<WorkflowAuthority["state"], TranslationKey>;

export const AUTHORITY_EFFECT_KEYS = {
  read: "authority.effect.read",
  write: "authority.effect.write",
  destructive: "authority.effect.destructive",
  unknown: "authority.effect.unknown",
} satisfies Record<
  WorkflowAuthority["effect_manifest"]["effects"][number]["effect"],
  TranslationKey
>;

export function observedAuthorityState(authority: WorkflowAuthority, now: number) {
  if (authority.state !== "approved") return authority.state;
  const until = authority.valid_until === null ? null : Date.parse(authority.valid_until);
  const from = Date.parse(authority.valid_from);
  if ((until !== null && !Number.isFinite(until)) || !Number.isFinite(from)) return "unavailable";
  if (until !== null && until <= now) return "expired";
  if (from > now) return "not_yet_valid";
  if (authority.remaining_runs !== null && authority.remaining_runs <= 0) return "exhausted";
  return authority.state;
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function authorityVersionLabel(
  versionId: string,
  versions: ReadonlyMap<string, number>,
): { text: string; full: string | null } {
  const number = versions.get(versionId);
  if (number !== undefined) return { text: `v${number}`, full: versionId };
  const short = shortIdentifier(versionId);
  return { text: short, full: short === versionId ? null : versionId };
}

export function authorityHeadline(
  authority: Pick<WorkflowAuthority, "execution_environment" | "valid_until" | "max_runs">,
  t: Translate,
  locale: Locale,
  now: number = Date.now(),
  timeZone?: string,
): string {
  const until = authority.valid_until === null ? Number.NaN : Date.parse(authority.valid_until);
  const sameYear =
    Number.isFinite(until) &&
    new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(until) ===
      new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(now);
  const when = Number.isFinite(until)
    ? new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
        day: "2-digit",
        month: "2-digit",
        ...(sameYear ? {} : { year: "numeric" as const }),
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
        ...(timeZone ? { timeZone } : {}),
      }).format(until)
    : null;
  return [
    t(
      authority.execution_environment === "prod" ? "authority.production" : "authority.development",
    ),
    authority.valid_until === null
      ? t("authority.headline.untilRevoked")
      : when
        ? t("authority.headline.until", { until: when })
        : null,
    authority.max_runs === null
      ? t("authority.headline.runs.unlimited")
      : t(
          authority.max_runs === 1
            ? "authority.headline.runs.one"
            : "authority.headline.runs.other",
          { max: authority.max_runs },
        ),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export type GrantLimit = "until_revoked" | "7d" | "30d";

export const DEFAULT_GRANT_LIMIT: GrantLimit = "until_revoked";

export function grantLimitBounds(limit: GrantLimit): { runs: null; hours: string | null } {
  return { runs: null, hours: limit === "7d" ? "168" : limit === "30d" ? "720" : null };
}

const DAY_MS = 86_400_000;

export function untilRevokedOffer(
  authority: WorkflowAuthority,
  now: number,
  canWrite: boolean,
): { days: number } | null {
  if (!canWrite || authority.valid_until === null || authority.revoked_at !== null) return null;
  if (observedAuthorityState(authority, now) !== "approved") return null;
  return { days: Math.max(1, Math.ceil((Date.parse(authority.valid_until) - now) / DAY_MS)) };
}
