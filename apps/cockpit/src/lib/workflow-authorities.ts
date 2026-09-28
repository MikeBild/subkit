import type { components } from "@/api/schema";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
import { shortIdentifier } from "@/pages/audit-model";

export type WorkflowAuthority = components["schemas"]["WorkflowExecutionAuthority"];
export type WorkflowAuthorityList = components["schemas"]["WorkflowExecutionAuthorityList"];
export type WorkflowAuthorityPreview = components["schemas"]["WorkflowAuthorityPreview"];

/** What one review request asked about. */
export type AuthorityReviewIdentity = {
  workflowId: string;
  versionId: string;
  environment: "dev" | "prod";
};

/**
 * Whether a review answer may be shown.
 *
 * `stale`: a newer request was started (or the dialog closed) after this one —
 * its answer is for a question nobody is asking any more, and showing it would
 * put a review on screen that the confirm button then refuses forever.
 * `mismatch`: the latest request, but the answer is about a different workflow,
 * version or environment than it asked. Never approvable (`authorityGrantInput`
 * refuses it); the dialog shows it with the re-check as the way out.
 */
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
  runs: string,
  hours: string,
  now: number,
) {
  const maxRuns = Number(runs);
  const duration = Number(hours);
  const from = Date.parse(preview.suggested_bounds.valid_from);
  const until = from + duration * 3_600_000;
  if (
    !preview.eligible_for_repeated_runs ||
    preview.manifest.workflow_id !== expected.workflowId ||
    preview.manifest.workflow_version_id !== expected.versionId ||
    preview.manifest.execution_environment !== expected.environment ||
    !Number.isInteger(maxRuns) ||
    maxRuns < 1 ||
    maxRuns > 10_000 ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 744 ||
    !Number.isFinite(from) ||
    !Number.isFinite(until) ||
    until <= now ||
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
    valid_until: new Date(until).toISOString(),
    max_runs: maxRuns,
  };
}

export const AUTHORITY_STATE_KEYS = {
  approved: "authority.state.approved",
  not_yet_valid: "authority.state.notYetValid",
  expired: "authority.state.expired",
  revoked: "authority.state.revoked",
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

/** A local clock may narrow an observed grant, but must never extend it. */
export function observedAuthorityState(authority: WorkflowAuthority, now: number) {
  if (authority.state !== "approved") return authority.state;
  const until = Date.parse(authority.valid_until);
  const from = Date.parse(authority.valid_from);
  if (!Number.isFinite(until) || !Number.isFinite(from)) return "unavailable";
  if (until <= now) return "expired";
  if (from > now) return "not_yet_valid";
  if (authority.remaining_runs <= 0) return "exhausted";
  return authority.state;
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * A workflow version as a reader names it: `v8`, when the page knows the
 * number; otherwise the shortened identifier (the caller hangs the whole one
 * on `title`). The page knows the running and the prepared version, which are
 * the two an approval is ever about.
 */
export function authorityVersionLabel(
  versionId: string,
  versions: ReadonlyMap<string, number>,
): { text: string; full: string | null } {
  const number = versions.get(versionId);
  if (number !== undefined) return { text: `v${number}`, full: versionId };
  const short = shortIdentifier(versionId);
  return { text: short, full: short === versionId ? null : versionId };
}

/**
 * What a reader decides an approval by, as its heading: where it runs, until
 * when, and how often — "Produktion · gültig bis 28.09., 18:00 · bis zu 24
 * Läufe". The card used to be headed by the approval's UUID, which is the one
 * fact about it nobody decides anything by.
 */
export function authorityHeadline(
  authority: Pick<WorkflowAuthority, "execution_environment" | "valid_until" | "max_runs">,
  t: Translate,
  locale: Locale,
  now: number = Date.now(),
  timeZone?: string,
): string {
  const until = Date.parse(authority.valid_until);
  // The year only when it is not this one, and always the zone: "bis 18:00"
  // read by someone in another zone, or next year, is a different moment.
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
    ...(when ? [t("authority.headline.until", { until: when })] : []),
    t(authority.max_runs === 1 ? "authority.headline.runs.one" : "authority.headline.runs.other", {
      max: authority.max_runs,
    }),
  ].join(" · ");
}
