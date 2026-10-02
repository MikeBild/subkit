// What the approval dialog says about the approval it is about to give —
// decided here, as pure functions, so the dialog only renders it.
//
// The dialog used to offer the same "allow N runs" whether or not an approval
// already covered the version, said nothing when the chosen environment was
// not the one anything runs in, and gave every hook-started workflow one run
// for one day without a word on why. Each of those is a fact the reader
// decides by.

import type { components } from "@/api/schema";
import { authorityIsLive } from "@/lib/automation-state";
import type { TranslationKey } from "@/lib/i18n";
import type { ReviewEnvironment } from "@/lib/review-environment";
import type { WorkflowAuthority, WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

type GateDiagnosis = components["schemas"]["GateDiagnosis"];

/**
 * The approval that already covers exactly what is being reviewed — the same
 * version in the same environment — or null. With one, a further approval
 * extends or re-bounds; it is never offered as if it were the first.
 */
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

/** Where the workflow is started without a person, production first. */
export function triggerEnvironments(
  schedules: readonly { execution_mode: ReviewEnvironment; paused: boolean }[] | null | undefined,
  webhooksActive: number | null | undefined,
): ReviewEnvironment[] {
  const started = new Set<ReviewEnvironment>(
    (schedules ?? []).filter((schedule) => !schedule.paused).map((entry) => entry.execution_mode),
  );
  // Unattended deliveries only ever run in production.
  if ((webhooksActive ?? 0) > 0) started.add("prod");
  return (["prod", "dev"] as const).filter((environment) => started.has(environment));
}

export type GrantScopeWarning =
  /** The approval is given where nothing starts the workflow. */
  | { kind: "other_environment"; selected: ReviewEnvironment; runsIn: ReviewEnvironment }
  /** The approval judges a saved change, and giving it puts that change into service. */
  | { kind: "saved_change"; active: number | null };

/**
 * What the reader should know about the scope of this approval before giving
 * it. Empty in the ordinary case — the running version, where it runs.
 */
export function grantScopeWarnings(input: {
  environment: ReviewEnvironment;
  startedIn: readonly ReviewEnvironment[];
  /** The dialog reviews a saved change that approving would activate. */
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

/**
 * What opening the dialog sets off, said BEFORE the press: the dialog runs a
 * trial as soon as it opens when the gate still needs to see what a step
 * sends, and for a hook-started workflow that trial needs one sample call.
 * Null when opening only shows the review.
 */
export function grantOpeningNotice(input: {
  diagnoses: readonly Pick<GateDiagnosis, "remedy_kind">[] | null | undefined;
  /** A hook starts it and no schedule supplies an input. */
  hookStarted: boolean;
  /** `workflow:run`: without it the dialog starts nothing. */
  mayRun: boolean;
}): "trial" | "sample" | null {
  if (!input.mayRun) return null;
  if (!(input.diagnoses ?? []).some((entry) => entry.remedy_kind === "prepare")) return null;
  return input.hookStarted ? "sample" : "trial";
}

/**
 * Whether only a hook starts the workflow: its trial run then has no input of
 * its own and asks for a sample call. A schedule supplies one.
 */
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

/**
 * The one line beside the suggested limits: where the numbers come from. Null
 * for the plain one-run default, which needs no explanation.
 */
export function suggestionNote(
  basis: WorkflowAuthorityPreview["suggested_bounds_basis"] | undefined,
): { key: TranslationKey; values: Record<string, number> } | null {
  if (!basis || basis.kind === "manual") return null;
  if (basis.kind === "schedule") return { key: "authority.suggestion.schedule", values: {} };
  return {
    key: basis.minimum_applied ? "authority.suggestion.hookMinimum" : "authority.suggestion.hook",
    values: { count: basis.observed_deliveries, days: basis.observed_days },
  };
}
