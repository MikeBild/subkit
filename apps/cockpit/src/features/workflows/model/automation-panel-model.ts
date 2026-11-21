import { type ConnectorAuthInput, connectorAuthState } from "@/features/connectors/model";
import type { AutomationState, AutomationWorkflow } from "@/features/grants/model";
import {
  STRIP_STATE_KEYS,
  type WaitingConnector,
  type workflowStrip,
} from "@/features/workflows/model/workflow-strip";
import { causeClassLabel } from "@/lib/cause-class";
import type { Translate, TranslationKey } from "@/lib/i18n";
import { statusLabel } from "@/lib/status-label";

type Strip = ReturnType<typeof workflowStrip>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function weekStart(now: number): string {
  return new Date(now - WEEK_MS).toISOString();
}

export function automationNow(tick: number, updatedAt: readonly number[]): number {
  return Math.max(tick, ...updatedAt);
}

export function hasPreparedDraft(
  workflow: Pick<AutomationWorkflow, "draft_version_id" | "current_version_id">,
): boolean {
  return (
    typeof workflow.draft_version_id === "string" &&
    workflow.draft_version_id !== workflow.current_version_id
  );
}

export function authorityItems<T>(
  pages: readonly ({ items?: readonly T[] | null } | null | undefined)[] | undefined,
): T[] | null {
  if (!pages || pages.some((page) => !Array.isArray(page?.items))) return null;
  return pages.flatMap((page) => page?.items ?? []);
}

export function workflowSchedules<T extends { workflow_id?: string | null }>(
  schedules: readonly T[] | null | undefined,
  workflowId: string,
): T[] | null {
  return Array.isArray(schedules)
    ? schedules.filter((entry) => entry.workflow_id === workflowId)
    : null;
}

export function verifiedStatus<T extends { schedules?: unknown; inbound_hooks?: unknown }>(
  status: T | null | undefined,
): T | null {
  return status && Array.isArray(status.schedules) && Array.isArray(status.inbound_hooks)
    ? status
    : null;
}

export function automationSettled(input: {
  authoritiesPending: boolean;
  schedulesPending: boolean;
  statusPending: boolean;
  draftPending: boolean;
  mayReadStatus: boolean;
  prepared: boolean;
}): boolean {
  return (
    !input.authoritiesPending &&
    !input.schedulesPending &&
    (!input.mayReadStatus || !input.statusPending) &&
    (!input.prepared || !input.draftPending)
  );
}

export function unansweredChecks(input: {
  mayReadStatus: boolean;
  statusPending: boolean;
  statusVerified: boolean;
  mayDiagnose: boolean;
  environmentKnown: boolean;
  diagnosisPending: boolean;
  diagnoses: unknown;
}): { status: boolean; diagnosis: boolean } {
  return {
    status: input.mayReadStatus && !input.statusPending && !input.statusVerified,
    diagnosis:
      input.mayDiagnose &&
      input.environmentKnown &&
      !input.diagnosisPending &&
      !Array.isArray(input.diagnoses),
  };
}

export function workflowVersions(
  workflow: Pick<AutomationWorkflow, "current_version_id" | "current_version">,
  draft: { version_id?: string | null; version?: number | null } | null | undefined,
): Map<string, number> {
  const versions = new Map<string, number>();
  if (workflow.current_version_id && typeof workflow.current_version === "number")
    versions.set(workflow.current_version_id, workflow.current_version);
  if (draft?.version_id && typeof draft.version === "number")
    versions.set(draft.version_id, draft.version);
  return versions;
}

export function environmentWord(t: Translate, environment: "dev" | "prod"): string {
  return t(environment === "prod" ? "authority.production" : "authority.development");
}

export function automationHeadline(
  state: AutomationState | null,
  t: Translate,
  dateTime: (value: string) => string,
): string | null {
  if (!state) return null;
  const version = state.facts.version === null ? null : `v${state.facts.version}`;
  const versionFact = version ? t("automation.fact.version", { version }) : null;
  switch (state.state) {
    case "approved":
      return [
        versionFact,
        environmentWord(t, state.environment),
        state.facts.untilRevoked
          ? t("automation.fact.untilRevoked")
          : state.facts.validUntil
            ? t("automation.fact.until", { until: dateTime(state.facts.validUntil) })
            : null,
        state.facts.runsLeft !== null && state.facts.runsMax !== null
          ? t("automation.fact.runs", { left: state.facts.runsLeft, max: state.facts.runsMax })
          : state.facts.runsSoFar !== null
            ? t(
                state.facts.runsSoFar === 1
                  ? "automation.fact.runsSoFar.one"
                  : "automation.fact.runsSoFar.other",
                { count: state.facts.runsSoFar },
              )
            : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "grant":
      return version
        ? t("automation.headline.grant", {
            version,
            environment: environmentWord(t, state.environment),
          })
        : t("automation.headline.grantUnnamed");
    case "repair":
      return state.facts.blockedStep
        ? t("automation.headline.repair", { step: state.facts.blockedStep })
        : t("automation.headline.repairUnnamed");
    case "apply": {
      const active = version ?? t("authority.noneActive");
      return state.facts.preparedVersion === null
        ? t("automation.headline.applyUnnamed", { active })
        : t("automation.headline.apply", {
            prepared: `v${state.facts.preparedVersion}`,
            active,
          });
    }
    case "invalid":
      return t("automation.headline.invalid");
    case "paused":
      return state.primaryAction === null
        ? t("automation.hookOff")
        : t("automation.headline.paused");
    case "unknown":
      return t("automation.headline.unknown");
    case "manual":
      return state.facts.inactive
        ? t("automation.headline.inactive")
        : [versionFact, t("automation.headline.manual")].filter(Boolean).join(" · ");
  }
}

export function failingLine(
  failure: { cause_class?: string | null; step_key?: string | null } | null,
  health: string,
  t: Translate,
): string {
  const cause = failure?.cause_class && failure.cause_class !== "ok" ? failure.cause_class : null;
  if (!cause) return t("detail.cause.noRun", { state: statusLabel(t, health) });
  const words = causeClassLabel(cause, t).text;
  return failure?.step_key
    ? t("detail.cause.atStep", { step: failure.step_key, cause: words })
    : t("detail.cause.class", { cause: words });
}

export function waitingConnectorFor(
  steps: readonly { connectorId: string | null; connector: string | null }[],
  records: readonly (ConnectorAuthInput & { id: string; slug: string; display_name: string })[],
): WaitingConnector | null {
  for (const step of steps) {
    const record = records.find(
      (item) =>
        (step.connectorId !== null && item.id === step.connectorId) ||
        (step.connector !== null && item.slug === step.connector),
    );
    if (!record) continue;
    const state = connectorAuthState(record);
    if (state === "expired" || state === "credentials_missing")
      return {
        id: record.id,
        name: record.display_name,
        state: state === "expired" ? "expired" : "missing",
      };
  }
  return null;
}

export function openRepair<T extends { reviewable?: boolean; review_digest?: string | null }>(
  items: readonly T[] | undefined,
): T | null {
  return items?.find((item) => item.reviewable && item.review_digest) ?? null;
}

function versionLabel(value: number | null | undefined, t: Translate): string {
  return value === null || value === undefined ? t("authority.noneActive") : `v${value}`;
}

export interface StripLineInput {
  strip: Strip;
  state: AutomationState | null;
  noticed: boolean;
  blocked: number;
  waitingConnector: WaitingConnector | null;
  failure: { cause_class?: string | null; step_key?: string | null } | null;
  health: string | null;
  repairDescription: string | null | undefined;
  lastRun: string;
  noRecentFailures: boolean;
  headline: string | null;
}

export function stripLine(input: StripLineInput, t: Translate): string | null {
  const { strip, state, waitingConnector } = input;
  switch (strip.kind) {
    case "loading":
      return null;
    case "empty":
      return t("workflowStrip.line.empty");
    case "failed":
      return t("authority.loadFailed");
    case "disabled":
      return t("workflowStrip.line.disabled");
    case "paused":
      if (input.noticed) return null;
      return state?.primaryAction === null
        ? t("automation.hookOff")
        : t("workflowStrip.line.paused");
    case "stopped":
      return t("workflowStrip.line.stopped", {
        environment: environmentWord(t, state?.environment ?? "prod"),
      });
    case "repair":
      return t(
        input.blocked === 1 ? "workflowStrip.line.blocked.one" : "workflowStrip.line.blocked.other",
        { count: input.blocked },
      );
    case "unapproved":
      return state?.state === "grant"
        ? t("workflowStrip.line.neverApproved", { version: versionLabel(state.facts.version, t) })
        : t("workflowStrip.line.unapproved");
    case "grant":
      return t("workflowStrip.line.grant", {
        version: versionLabel(state?.facts.version, t),
        environment: environmentWord(t, state?.environment ?? "prod"),
      });
    case "apply":
      return t("workflowStrip.line.apply", {
        prepared: versionLabel(state?.facts.preparedVersion, t),
        active: versionLabel(state?.facts.version, t),
      });
    case "connector":
      return waitingConnector
        ? t(
            waitingConnector.state === "deleted"
              ? "workflowStrip.line.connectorDeleted"
              : waitingConnector.state === "expired"
                ? "workflowStrip.line.connectorExpired"
                : "workflowStrip.line.connectorMissing",
            { name: waitingConnector.name },
          )
        : null;
    case "failing":
      return failingLine(input.failure, input.health ?? "failing", t);
    case "repairPrepared":
      return input.repairDescription ?? t("workflowStrip.headline.repairPrepared");
    case "approved":
    case "manual":
      return [
        input.lastRun,
        input.noRecentFailures ? t("workflowStrip.line.noRecentFailures") : null,
      ]
        .filter(Boolean)
        .join(" · ");
    default:
      return input.headline;
  }
}

export function stripHelp(
  input: { strip: Strip; notice: TranslationKey | null; adoptable: boolean; canWrite: boolean },
  t: Translate,
): string[] {
  const { strip } = input;
  return [
    ...(strip.lower.length > 0
      ? [
          t("workflowStrip.also", {
            states: strip.lower.map((kind) => t(STRIP_STATE_KEYS[kind])).join(", "),
          }),
        ]
      : []),
    ...(input.notice && !input.adoptable ? [t(input.notice)] : []),
    ...(input.adoptable ? [t("authority.review.help.adopt")] : []),
    ...(!input.canWrite &&
    strip.action === null &&
    (strip.tone === "warn" || strip.tone === "error")
      ? [t("automation.noRight")]
      : []),
  ];
}
