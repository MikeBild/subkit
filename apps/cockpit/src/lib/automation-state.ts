import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";
import { type ReviewEnvironment, reviewEnvironment } from "@/lib/review-environment";
import { type ReviewTarget, reviewTarget } from "@/lib/review-target";
import { observedAuthorityState, type WorkflowAuthority } from "@/lib/workflow-authorities";

type GateDiagnosis = components["schemas"]["GateDiagnosis"];

export type AutomationStateKind =
  | "invalid"
  | "paused"
  | "apply"
  | "repair"
  | "unknown"
  | "grant"
  | "approved"
  | "manual";

export type AutomationRowState =
  | "paused"
  | "activation_required"
  | "input_required"
  | "repair_required"
  | "approval_required"
  | "authorized"
  | "verification_unavailable";

export interface AutomationStatusLike {
  schedules: readonly {
    schedule_id: string;
    state: AutomationRowState;
    cron: string;
    timezone: string;
    environment: ReviewEnvironment;
    next_run_at: string | null;
  }[];
  inbound_hooks: readonly {
    inbound_hook_id: string;
    slug: string;
    state: AutomationRowState;
    environment: "prod";
  }[];
}

export interface ScheduleLike {
  id: string;
  cron: string;
  timezone: string;
  execution_mode: ReviewEnvironment;
  paused: boolean;
  admission_hold?: unknown;
}

export interface AutomationWorkflow {
  lifecycle?: string | null;
  current_version_id?: string | null;
  draft_version_id?: string | null;
  current_version?: number | null;
  webhooks_active?: number | null;
  invalid?: boolean | null;
}

export interface AutomationInputs {
  workflow: AutomationWorkflow;
  draft?: { version_id: string; version: number } | null;
  schedules: readonly ScheduleLike[] | null;
  status: AutomationStatusLike | null;
  authorities: readonly WorkflowAuthority[] | null;
  diagnosis: { is_current: boolean; diagnoses: readonly GateDiagnosis[] } | null;
  unanswered: { status: boolean; diagnosis: boolean };
  now: number;
}

export interface AutomationTrigger {
  kind: "schedule" | "hook";
  id: string | null;
  cron: string | null;
  timezone: string | null;
  slug: string | null;
  environment: ReviewEnvironment;
  paused: boolean;
  nextRunAt: string | null;
}

export type AutomationAction =
  | { kind: "resume"; scheduleIds: string[] }
  | { kind: "apply" }
  | { kind: "grant" }
  | { kind: "extend" }
  | { kind: "view" }
  | {
      kind: "repair";
      via: "review" | "auto" | "prepare" | "chat";
      stepId: string | null;
    };

export interface AutomationState {
  state: AutomationStateKind;
  environment: ReviewEnvironment;
  target: ReviewTarget | null;
  facts: {
    version: number | null;
    preparedVersion: number | null;
    validUntil: string | null;
    runsLeft: number | null;
    runsMax: number | null;
    runsSoFar: number | null;
    untilRevoked: boolean;
    blockedStep: string | null;
    inactive: boolean;
  };
  grant: WorkflowAuthority | null;
  alsoValid: WorkflowAuthority[];
  history: WorkflowAuthority[];
  triggers: AutomationTrigger[];
  pendingEnvironments: ReviewEnvironment[];
  primaryAction: AutomationAction | null;
  secondaryAction: AutomationAction | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXTEND_WITHIN_DAYS = 3;
export const EXTEND_WITHIN_MS = EXTEND_WITHIN_DAYS * DAY_MS;
export const EXTEND_BELOW_RUN_SHARE = 0.1;

export function authorityIsLive(authority: WorkflowAuthority, now: number): boolean {
  return (
    authority.active_version &&
    authority.ready_for_new_run &&
    observedAuthorityState(authority, now) === "approved"
  );
}

export function grantNeedsExtension(
  grant: Pick<WorkflowAuthority, "valid_until" | "remaining_runs" | "max_runs">,
  now: number,
): boolean {
  const until = grant.valid_until === null ? Number.NaN : Date.parse(grant.valid_until);
  if (Number.isFinite(until) && until - now < EXTEND_WITHIN_MS) return true;
  return (
    grant.max_runs !== null &&
    grant.remaining_runs !== null &&
    grant.max_runs > 0 &&
    grant.remaining_runs / grant.max_runs < EXTEND_BELOW_RUN_SHARE
  );
}

export function automationTriggers(
  status: AutomationStatusLike | null,
  schedules: readonly ScheduleLike[] | null,
): AutomationTrigger[] {
  const paused = new Map((schedules ?? []).map((schedule) => [schedule.id, schedule.paused]));
  const listed = (schedules ?? []).map(
    (schedule): AutomationTrigger => ({
      kind: "schedule",
      id: schedule.id,
      cron: schedule.cron,
      timezone: schedule.timezone,
      slug: null,
      environment: schedule.execution_mode,
      paused: schedule.paused,
      nextRunAt: null,
    }),
  );
  if (!status) return listed;
  const verified = new Set(status.schedules.map((row) => row.schedule_id));
  return [
    ...status.schedules.map(
      (row): AutomationTrigger => ({
        kind: "schedule",
        id: row.schedule_id,
        cron: row.cron,
        timezone: row.timezone,
        slug: null,
        environment: row.environment,
        paused: row.state === "paused" || paused.get(row.schedule_id) === true,
        nextRunAt: row.next_run_at,
      }),
    ),
    ...listed.filter((trigger) => trigger.id !== null && !verified.has(trigger.id)),
    ...status.inbound_hooks.map(
      (row): AutomationTrigger => ({
        kind: "hook",
        id: null,
        cron: null,
        timezone: null,
        slug: row.slug,
        environment: "prod",
        paused: row.state === "paused",
        nextRunAt: null,
      }),
    ),
  ];
}

function productionFirst(environments: Iterable<ReviewEnvironment>): ReviewEnvironment[] {
  const set = new Set(environments);
  return (["prod", "dev"] as const).filter((environment) => set.has(environment));
}

function pendingRowEnvironments(status: AutomationStatusLike | null): ReviewEnvironment[] {
  if (!status) return [];
  return productionFirst(
    [...status.schedules, ...status.inbound_hooks]
      .filter((row) => row.state !== "paused" && row.state !== "authorized")
      .map((row) => row.environment),
  );
}

function uncoveredEnvironments(
  input: Pick<AutomationInputs, "workflow" | "schedules" | "status" | "authorities" | "now">,
): ReviewEnvironment[] {
  if (input.status) return [];
  const started = productionFirst([
    ...automationTriggers(null, input.schedules)
      .filter((trigger) => !trigger.paused)
      .map((trigger) => trigger.environment),
    ...((input.workflow.webhooks_active ?? 0) > 0 ? (["prod"] as const) : []),
  ]);
  return started.filter(
    (environment) =>
      !(input.authorities ?? []).some(
        (authority) =>
          authority.execution_environment === environment && authorityIsLive(authority, input.now),
      ),
  );
}

export function automationEnvironment(
  input: Pick<AutomationInputs, "workflow" | "schedules" | "status" | "authorities" | "now">,
): ReviewEnvironment {
  const [pending] = [...pendingRowEnvironments(input.status), ...uncoveredEnvironments(input)];
  if (pending) return pending;
  const triggers = automationTriggers(input.status, input.schedules);
  const running = triggers.filter((trigger) => !trigger.paused);
  const pool = running.length > 0 ? running : triggers;
  if (pool.some((trigger) => trigger.environment === "prod")) return "prod";
  if ((input.workflow.webhooks_active ?? 0) > 0) return "prod";
  if (pool.length > 0) return "dev";
  return reviewEnvironment(input.authorities ?? [], undefined, new Date(input.now));
}

export function automationRepairAction(
  entry: GateDiagnosis | undefined,
  isCurrent: boolean,
): Extract<AutomationAction, { kind: "repair" }> {
  if (!entry) return { kind: "repair", via: "chat", stepId: null };
  const stepId = entry.subject.step_id;
  if (entry.fixer && isCurrent)
    return { kind: "repair", via: entry.candidate_id ? "review" : "auto", stepId };
  if (entry.remedy_kind === "prepare") return { kind: "repair", via: "prepare", stepId };
  return { kind: "repair", via: "chat", stepId };
}

export function automationState(input: AutomationInputs): AutomationState {
  const { workflow, now } = input;
  const environment = automationEnvironment(input);
  const target = reviewTarget(workflow, input.draft);
  const triggers = automationTriggers(input.status, input.schedules);
  const authorities = input.authorities ?? [];
  const live = (authority: WorkflowAuthority) => authorityIsLive(authority, now);
  const grant =
    authorities.find(
      (authority) => authority.execution_environment === environment && live(authority),
    ) ?? null;
  const shown = (current: WorkflowAuthority | null) => {
    const others = authorities.filter((authority) => authority !== current);
    return {
      grant: current,
      alsoValid: others.filter(live),
      history: others.filter((authority) => !live(authority)),
    };
  };

  const hiddenHooks =
    (workflow.webhooks_active ?? 0) > 0 && !triggers.some((trigger) => trigger.kind === "hook");
  const hasAutomation = triggers.length > 0 || hiddenHooks;
  const running = triggers.filter((trigger) => !trigger.paused);
  const rows: AutomationRowState[] = input.status
    ? [...input.status.schedules, ...input.status.inbound_hooks]
        .map((row) => row.state)
        .filter((state) => state !== "paused")
    : [];
  const blocks = input.diagnosis?.diagnoses ?? [];

  const pendingRows = [...pendingRowEnvironments(input.status), ...uncoveredEnvironments(input)];
  const startedIn = productionFirst([
    ...running.map((trigger) => trigger.environment),
    ...(hiddenHooks ? (["prod"] as const) : []),
  ]);
  const base = {
    environment,
    target,
    triggers,
    secondaryAction: null,
    pendingEnvironments: pendingRows.length > 0 ? pendingRows : [environment],
  } satisfies Partial<AutomationState>;
  const viewGrant: AutomationAction | null = authorities.some(live) ? { kind: "view" } : null;
  const facts = {
    version: workflow.current_version ?? null,
    preparedVersion: null,
    validUntil: null,
    runsLeft: null,
    runsMax: null,
    runsSoFar: null,
    untilRevoked: false,
    blockedStep: null,
    inactive: false,
  } satisfies AutomationState["facts"];

  if (workflow.invalid === true && target?.kind !== "prepared") {
    return {
      ...base,
      state: "invalid",
      facts,
      ...shown(null),
      pendingEnvironments: [],
      primaryAction: { kind: "repair", via: "chat", stepId: null },
      secondaryAction: viewGrant,
    };
  }

  if (triggers.length > 0 && running.length === 0 && !hiddenHooks) {
    const scheduleIds = triggers.flatMap((trigger) =>
      trigger.kind === "schedule" && trigger.id ? [trigger.id] : [],
    );
    return {
      ...base,
      state: "paused",
      facts,
      ...shown(grant),
      pendingEnvironments: [],
      primaryAction: scheduleIds.length > 0 ? { kind: "resume", scheduleIds } : null,
      secondaryAction: viewGrant,
    };
  }

  if (target?.kind === "prepared") {
    return {
      ...base,
      state: "apply",
      facts: { ...facts, preparedVersion: target.version },
      ...shown(grant),
      pendingEnvironments: startedIn.length > 0 ? startedIn : [environment],
      primaryAction: { kind: "apply" },
      secondaryAction: viewGrant,
    };
  }

  const needsRepair =
    blocks.length > 0 || rows.some((row) => row === "repair_required" || row === "input_required");
  if (needsRepair) {
    const action = automationRepairAction(blocks[0], input.diagnosis?.is_current ?? false);
    return {
      ...base,
      state: "repair",
      facts: { ...facts, blockedStep: action.stepId },
      ...shown(grant),
      primaryAction: action,
      secondaryAction: viewGrant,
    };
  }

  const unknown = (): AutomationState => ({
    ...base,
    state: "unknown",
    facts,
    ...shown(null),
    pendingEnvironments: [],
    primaryAction: null,
    secondaryAction: viewGrant,
  });
  const triggersUnread = input.schedules === null && input.status === null;
  if (
    input.authorities === null ||
    triggersUnread ||
    input.unanswered.status ||
    input.unanswered.diagnosis ||
    rows.includes("verification_unavailable")
  )
    return unknown();

  const inactive = workflow.lifecycle !== "active" || !workflow.current_version_id;
  const approvedFacts = grant
    ? {
        ...facts,
        validUntil: grant.valid_until,
        runsLeft: grant.remaining_runs,
        runsMax: grant.max_runs,
        runsSoFar: grant.reserved_runs,
        untilRevoked: grant.valid_until === null,
      }
    : facts;
  const approved = (): AutomationState => ({
    ...base,
    state: "approved",
    facts: approvedFacts,
    ...shown(grant),
    pendingEnvironments: [],
    primaryAction: grant ? { kind: "view" } : null,
    secondaryAction: grant && grantNeedsExtension(grant, now) ? { kind: "extend" } : null,
  });

  if (inactive) {
    return {
      ...base,
      state: "manual",
      facts: { ...facts, inactive: true },
      ...shown(null),
      pendingEnvironments: [],
      primaryAction: null,
      secondaryAction: viewGrant,
    };
  }

  const needsGrant = (): AutomationState => ({
    ...base,
    state: "grant",
    facts,
    ...shown(null),
    primaryAction: { kind: "grant" },
    secondaryAction: viewGrant,
  });

  if (hasAutomation) {
    const verified = rows.length > 0;
    const allAuthorized = verified && rows.every((row) => row === "authorized");
    const hookUnverified =
      hiddenHooks &&
      allAuthorized &&
      !(input.status?.schedules ?? []).some(
        (row) => row.environment === "prod" && row.state === "authorized",
      );
    if (hookUnverified) return grant ? unknown() : needsGrant();
    if (verified ? allAuthorized : grant !== null) return approved();
    return needsGrant();
  }

  if (grant) return approved();
  return {
    ...base,
    state: "manual",
    facts,
    ...shown(null),
    primaryAction: { kind: "grant" },
    secondaryAction: viewGrant,
  };
}

export function automationNeedsMoreApprovals(
  state: Pick<AutomationState, "state" | "grant">,
  hasMore: boolean,
): boolean {
  return hasMore && state.state === "approved" && state.grant === null;
}

export interface AutomationRights {
  write: boolean;
  run: boolean;
  chat: boolean;
}

export function automationActionPermitted(
  action: AutomationAction,
  rights: AutomationRights,
): boolean {
  switch (action.kind) {
    case "view":
      return true;
    case "resume":
    case "apply":
    case "grant":
    case "extend":
      return rights.write;
    case "repair":
      if (action.via === "prepare") return rights.run;
      if (action.via === "chat") return rights.chat;
      return rights.write;
  }
}

export const AUTOMATION_STATE_KEYS = {
  invalid: "automation.state.invalid",
  paused: "automation.state.paused",
  apply: "automation.state.apply",
  repair: "automation.state.repair",
  unknown: "automation.state.unknown",
  grant: "automation.state.grant",
  approved: "automation.state.approved",
  manual: "automation.state.manual",
} satisfies Record<AutomationStateKind, TranslationKey>;

export function automationActionKey(action: AutomationAction): TranslationKey {
  switch (action.kind) {
    case "resume":
      return "automation.action.resume";
    case "apply":
      return "automation.action.apply";
    case "grant":
      return "automation.action.grant";
    case "extend":
      return "automation.action.extend";
    case "view":
      return "automation.action.view";
    case "repair":
      return action.via === "review"
        ? "remedy.reviewRepair"
        : action.via === "auto"
          ? "diagnosis.repair"
          : action.via === "prepare"
            ? "diagnosis.prepare"
            : "remedy.chat";
  }
}

export interface AutomationCard {
  titleKey: TranslationKey;
  hintKey: TranslationKey;
  act: "review" | "resume" | "recheck" | "none";
  actionKey: TranslationKey;
  environments: ReviewEnvironment[];
}

export function automationCard(
  state: AutomationState,
  webhooksActive: number | null | undefined,
): AutomationCard {
  const calm: Pick<AutomationCard, "act" | "actionKey" | "environments"> = {
    act: "none",
    actionKey: "automation.action.view",
    environments: [],
  };
  const review = (
    summary: "repair" | "review" | "apply",
    hintKey: TranslationKey,
    actionKey: TranslationKey,
  ): AutomationCard => ({
    titleKey: `chat.automationCard.${summary}.title`,
    hintKey,
    act: "review",
    actionKey,
    environments:
      state.pendingEnvironments.length > 0 ? state.pendingEnvironments : [state.environment],
  });
  switch (state.state) {
    case "approved":
      return {
        ...calm,
        titleKey: "chat.automationCard.authorized.title",
        hintKey: "chat.automationCard.authorized.hint",
      };
    case "invalid":
      return {
        ...calm,
        titleKey: AUTOMATION_STATE_KEYS.invalid,
        hintKey: "automation.headline.invalid",
      };
    case "manual":
      return {
        ...calm,
        titleKey: AUTOMATION_STATE_KEYS.manual,
        hintKey: state.facts.inactive
          ? "automation.headline.inactive"
          : "automation.headline.manual",
      };
    case "paused": {
      const resumable = state.primaryAction?.kind === "resume";
      return {
        ...calm,
        titleKey: AUTOMATION_STATE_KEYS.paused,
        hintKey: resumable ? "automation.headline.paused" : "automation.hookOff",
        act: resumable ? "resume" : "none",
        actionKey: "automation.action.resume",
      };
    }
    case "unknown":
      return {
        ...calm,
        titleKey: "chat.automationCard.unknown.title",
        hintKey: "automation.headline.unknown",
        act: "recheck",
        actionKey: "automation.action.recheck",
      };
    case "apply":
      return review(
        "apply",
        "chat.automationCard.apply.hint",
        automationActionKey({ kind: "apply" }),
      );
    case "repair":
      return review(
        "repair",
        "chat.automationCard.repair.hint",
        "chat.automationCard.repair.action",
      );
    case "grant": {
      const running = state.triggers.filter((trigger) => !trigger.paused);
      const scheduled = running.some((trigger) => trigger.kind === "schedule");
      const hooked =
        running.some((trigger) => trigger.kind === "hook") || (webhooksActive ?? 0) > 0;
      return review(
        "review",
        scheduled && !hooked
          ? "chat.automationCard.review.hint.schedule"
          : hooked && !scheduled
            ? "chat.automationCard.review.hint.hook"
            : "chat.automationCard.review.hint.any",
        automationActionKey({ kind: "grant" }),
      );
    }
  }
}
