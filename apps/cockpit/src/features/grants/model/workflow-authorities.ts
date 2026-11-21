import type { Translate } from "@/lib/i18n";

export { observedAuthorityState } from "@shared/workflow-automation.ts";

import type { components } from "@cli-core/engine-api/openapi";
import {
  authorityHeadline as coreAuthorityHeadline,
  authorityVersionLabel as coreAuthorityVersionLabel,
} from "@/features/grants/model/authority-view";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";

export type { AuthorityReviewIdentity } from "@/features/grants/model/authority-decision";
export {
  acceptReview,
  authorityGrantInput,
  authorityGrantInputUntil,
  untilRevokedOffer,
} from "@/features/grants/model/authority-decision";

export type WorkflowAuthority = components["schemas"]["WorkflowExecutionAuthority"];
export type WorkflowAuthorityList = components["schemas"]["WorkflowExecutionAuthorityList"];
export type WorkflowAuthorityPreview = components["schemas"]["WorkflowAuthorityPreview"];

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

export function authorityVersionLabel(
  versionId: string,
  versions: ReadonlyMap<string, number>,
): { text: string; full: string | null } {
  return coreAuthorityVersionLabel(versionId, versions);
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
  return coreAuthorityHeadline(
    {
      execution_environment: authority.execution_environment,
      valid_until: authority.valid_until,
      max_runs: authority.max_runs,
      until_label: when,
    },
    t,
  );
}
