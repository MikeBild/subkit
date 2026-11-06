import type { components } from "@cli-core/engine-api/openapi";
import { authorityIsLive } from "@/lib/automation-state";
import { pluralKey, type TranslationKey } from "@/lib/i18n";
import type { ReviewEnvironment } from "@/lib/review-environment";
import type { WorkflowAuthority, WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

type GateDiagnosis = components["schemas"]["GateDiagnosis"];

export function existingGrant(
  authorities: readonly WorkflowAuthority[] | null | undefined,
  versionId: string,
  environment: ReviewEnvironment,
  now: number,
): WorkflowAuthority | null {
  return (
    (authorities ?? []).find(
      (authority) =>
        authority.workflow_version_id === versionId &&
        authority.execution_environment === environment &&
        authorityIsLive(authority, now),
    ) ?? null
  );
}

export function triggerEnvironments(
  schedules: readonly { execution_mode: ReviewEnvironment; paused: boolean }[] | null | undefined,
  webhooksActive: number | null | undefined,
): ReviewEnvironment[] {
  const started = new Set<ReviewEnvironment>(
    (schedules ?? []).filter((schedule) => !schedule.paused).map((entry) => entry.execution_mode),
  );
  if ((webhooksActive ?? 0) > 0) started.add("prod");
  return (["prod", "dev"] as const).filter((environment) => started.has(environment));
}

export type GrantScopeWarning =
  | { kind: "other_environment"; selected: ReviewEnvironment; runsIn: ReviewEnvironment }
  | { kind: "saved_change"; active: number | null };

export function grantScopeWarnings(input: {
  environment: ReviewEnvironment;
  startedIn: readonly ReviewEnvironment[];
  savedChange: boolean;
  activeVersion: number | null;
}): GrantScopeWarning[] {
  const warnings: GrantScopeWarning[] = [];
  const [runsIn] = input.startedIn;
  if (runsIn && !input.startedIn.includes(input.environment))
    warnings.push({ kind: "other_environment", selected: input.environment, runsIn });
  if (input.savedChange) warnings.push({ kind: "saved_change", active: input.activeVersion });
  return warnings;
}

export function grantOpeningNotice(input: {
  diagnoses: readonly Pick<GateDiagnosis, "remedy_kind">[] | null | undefined;
  hookStarted: boolean;
  mayRun: boolean;
}): "trial" | "sample" | null {
  if (!input.mayRun) return null;
  if (!(input.diagnoses ?? []).some((entry) => entry.remedy_kind === "prepare")) return null;
  return input.hookStarted ? "sample" : "trial";
}

export function hookStartedOnly(
  triggers: readonly { kind: "schedule" | "hook"; paused: boolean }[],
  webhooksActive: number | null | undefined,
): boolean {
  const running = triggers.filter((trigger) => !trigger.paused);
  if (running.some((trigger) => trigger.kind === "schedule")) return false;
  return running.some((trigger) => trigger.kind === "hook") || (webhooksActive ?? 0) > 0;
}

export const OPENING_NOTICE_KEYS = {
  trial: "automation.opening.trial",
  sample: "automation.opening.sample",
} satisfies Record<"trial" | "sample", TranslationKey>;

export function suggestionNote(
  basis: WorkflowAuthorityPreview["suggested_bounds_basis"] | undefined,
): { key: TranslationKey; values: Record<string, number> } | null {
  if (!basis || basis.kind === "manual") return null;
  if (basis.kind === "schedule") return { key: "authority.suggestion.schedule", values: {} };
  if (basis.observed_deliveries === 0)
    return { key: "authority.suggestion.hookNone", values: { days: basis.observed_days } };
  return {
    key: pluralKey(
      basis.minimum_applied ? "authority.suggestion.hookMinimum" : "authority.suggestion.hook",
      basis.observed_deliveries,
    ),
    values: { count: basis.observed_deliveries, days: basis.observed_days },
  };
}
