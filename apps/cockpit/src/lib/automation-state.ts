// Whether a workflow may run on its own — ONE state and ONE next step.
//
// The workflow page used to answer this in four places that did not agree: a
// title link that only scrolled, a section button that stayed after a grant, a
// "review needed" badge, and the diagnosis block. A reader could not tell
// whether the workflow was approved, nor where approving happened.
//
// This module is the single decision. It is pure: it takes what the engine
// already reports — the workflow record, its schedules, the verified
// automation status, the approvals and the gate diagnosis — and returns the
// state, the facts that head it and the one action that moves it forward. The
// page's panel, the action beside the title and the chat's review card all
// read it, so they cannot disagree.
//
// Precedence — the first that applies wins:
//
//   1. paused    every schedule and hook is stopped; nothing else matters.
//   2. apply     a saved change differs from the running version. Judging the
//                running version would describe problems the change may
//                already have solved.
//   3. repair    the gate refuses a step. This holds even while an approval
//                exists: the diagnosis includes the refused step of the newest
//                approved run ("the approval no longer fits").
//   4. unknown   the engine could not verify readiness. Never read as approved.
//   5. grant     something starts it automatically and no approval covers it.
//   6. approved  a current approval covers the running version.
//   7. manual    nothing starts it automatically and nothing is approved — a
//                calm state, not a task.

import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";
import { type ReviewEnvironment, reviewEnvironment } from "@/lib/review-environment";
import { type ReviewTarget, reviewTarget } from "@/lib/review-target";
import { observedAuthorityState, type WorkflowAuthority } from "@/lib/workflow-authorities";

type GateDiagnosis = components["schemas"]["GateDiagnosis"];

export type AutomationStateKind =
  | "paused"
  | "apply"
  | "repair"
  | "unknown"
  | "grant"
  | "approved"
  | "manual";

/** The engine's verdict on one schedule or hook (`GET …/automation-status`). */
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
  /** Active inbound hooks, from the record — readable without `inbound_hook:read`. */
  webhooks_active?: number | null;
}

export interface AutomationInputs {
  workflow: AutomationWorkflow;
  /** The saved draft's number, when the page read it. Only improves a label. */
  draft?: { version_id: string; version: number } | null;
  /** `GET /v1/schedules?workflow_id=` — null when it could not be read. */
  schedules: readonly ScheduleLike[] | null;
  /** `GET …/automation-status` — null when the reader may not ask, or it failed. */
  status: AutomationStatusLike | null;
  /** `GET …/execution-authorities`, newest first — null when it could not be read. */
  authorities: readonly WorkflowAuthority[] | null;
  /** `GET …/diagnosis` for `automationEnvironment(...)` — null until it answered. */
  diagnosis: { is_current: boolean; diagnoses: readonly GateDiagnosis[] } | null;
  now: number;
}

/** One thing that starts the workflow without a person. */
export interface AutomationTrigger {
  kind: "schedule" | "hook";
  /** The schedule's id, to resume it. Null for a hook. */
  id: string | null;
  cron: string | null;
  timezone: string | null;
  slug: string | null;
  environment: ReviewEnvironment;
  paused: boolean;
  nextRunAt: string | null;
}

export type AutomationAction =
  /** Resume the paused schedules. */
  | { kind: "resume"; scheduleIds: string[] }
  /** Review the saved change — the approval dialog for the prepared version. */
  | { kind: "apply" }
  /** Open the approval dialog for the running version. */
  | { kind: "grant" }
  /** Extend or re-bound a current approval — the same dialog. */
  | { kind: "extend" }
  /** Scroll to and open the current approval. */
  | { kind: "view" }
  /**
   * Remove the first block the gate names. `review`: a repair is already
   * proposed; `auto`: the engine can compute one; `prepare`: a trial run
   * supplies the missing evidence; `chat`: an author has to change the step.
   */
  | {
      kind: "repair";
      via: "review" | "auto" | "prepare" | "chat";
      stepId: string | null;
    };

export interface AutomationState {
  state: AutomationStateKind;
  /** Where automatic runs happen, and so where the approval is judged. */
  environment: ReviewEnvironment;
  /** Which version an approval would judge; null before anything was saved. */
  target: ReviewTarget | null;
  facts: {
    /** The running version's number. */
    version: number | null;
    /** The saved change's number, in state `apply`. */
    preparedVersion: number | null;
    validUntil: string | null;
    runsLeft: number | null;
    runsMax: number | null;
    /** The step the gate refuses first, in state `repair`. */
    blockedStep: string | null;
    /** In state `manual`: the workflow has no running version at all. */
    inactive: boolean;
  };
  /** The approval that currently covers the running version (state `approved`). */
  grant: WorkflowAuthority | null;
  /** Further approvals a run could still use — another environment or window. */
  alsoValid: WorkflowAuthority[];
  /** Every other approval — expired, revoked, used up, or for another version. */
  history: WorkflowAuthority[];
  triggers: AutomationTrigger[];
  /** The one action that moves the state forward. Null when there is none. */
  primaryAction: AutomationAction | null;
  /**
   * At most one further action: extending an approval that is running out, or
   * looking at the existing approval while another step is pending.
   */
  secondaryAction: AutomationAction | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** An approval is offered for extension this long before it ends … */
export const EXTEND_WITHIN_MS = 3 * DAY_MS;
/** … or once fewer than this share of its runs is left. */
export const EXTEND_BELOW_RUN_SHARE = 0.1;

/** Whether a current approval is close enough to its end to offer extending it. */
export function grantNeedsExtension(
  grant: Pick<WorkflowAuthority, "valid_until" | "remaining_runs" | "max_runs">,
  now: number,
): boolean {
  const until = Date.parse(grant.valid_until);
  if (Number.isFinite(until) && until - now < EXTEND_WITHIN_MS) return true;
  return grant.max_runs > 0 && grant.remaining_runs / grant.max_runs < EXTEND_BELOW_RUN_SHARE;
}

/** What starts the workflow on its own, from the best source the page has. */
export function automationTriggers(
  status: AutomationStatusLike | null,
  schedules: readonly ScheduleLike[] | null,
): AutomationTrigger[] {
  const paused = new Map((schedules ?? []).map((schedule) => [schedule.id, schedule.paused]));
  const fromStatus: AutomationTrigger[] = status
    ? [
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
      ]
    : [];
  if (status) return fromStatus;
  return (schedules ?? []).map((schedule) => ({
    kind: "schedule",
    id: schedule.id,
    cron: schedule.cron,
    timezone: schedule.timezone,
    slug: null,
    environment: schedule.execution_mode,
    paused: schedule.paused,
    nextRunAt: null,
  }));
}

/**
 * The environment automatic runs use, and so the one the approval and the
 * diagnosis are judged in: a hook's deliveries always run in production; a
 * schedule names its own; without either, the workflow's approvals say where
 * it belongs (`reviewEnvironment`).
 *
 * Needs only what the page reads before the diagnosis, so the diagnosis can be
 * asked for the right half of the installation.
 */
export function automationEnvironment(
  input: Pick<AutomationInputs, "workflow" | "schedules" | "status" | "authorities" | "now">,
): ReviewEnvironment {
  const triggers = automationTriggers(input.status, input.schedules);
  const running = triggers.filter((trigger) => !trigger.paused);
  const pool = running.length > 0 ? running : triggers;
  if (pool.some((trigger) => trigger.environment === "prod")) return "prod";
  if ((input.workflow.webhooks_active ?? 0) > 0) return "prod";
  if (pool.length > 0) return "dev";
  return reviewEnvironment(input.authorities ?? [], undefined, new Date(input.now));
}

function repairAction(
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
  // The approval that covers the running version here and now. The server's
  // state already folds in a changed effect manifest; the local clock may only
  // narrow it.
  const live = (authority: WorkflowAuthority) =>
    authority.active_version &&
    authority.ready_for_new_run &&
    observedAuthorityState(authority, now) === "approved";
  const grant =
    authorities.find(
      (authority) => authority.execution_environment === environment && live(authority),
    ) ?? null;
  // Every approval is listed exactly once: the one the state rests on, the
  // others a run could still use (another environment, a second window), and
  // the rest as history.
  const shown = (current: WorkflowAuthority | null) => {
    const others = authorities.filter((authority) => authority !== current);
    return {
      grant: current,
      alsoValid: others.filter(live),
      history: others.filter((authority) => !live(authority)),
    };
  };

  // Hooks the reader may not list still count: the record carries their number.
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

  const base = {
    environment,
    target,
    triggers,
    secondaryAction: null,
  } satisfies Partial<AutomationState>;
  // While something else is pending, an approval that exists stays one press
  // away: it is the evidence a reader checks the pending step against.
  const viewGrant: AutomationAction | null = grant ? { kind: "view" } : null;
  const facts = {
    version: workflow.current_version ?? null,
    preparedVersion: null,
    validUntil: null,
    runsLeft: null,
    runsMax: null,
    blockedStep: null,
    inactive: false,
  } satisfies AutomationState["facts"];

  // 1. Everything that would start it is stopped.
  if (triggers.length > 0 && running.length === 0 && !hiddenHooks) {
    const scheduleIds = triggers.flatMap((trigger) =>
      trigger.kind === "schedule" && trigger.id ? [trigger.id] : [],
    );
    return {
      ...base,
      state: "paused",
      facts,
      ...shown(grant),
      primaryAction: scheduleIds.length > 0 ? { kind: "resume", scheduleIds } : null,
      secondaryAction: viewGrant,
    };
  }

  // 2. A saved change waits. The approval judges that change, not the running
  //    version, and applying it is part of the same decision.
  if (target?.kind === "prepared") {
    return {
      ...base,
      state: "apply",
      facts: { ...facts, preparedVersion: target.version },
      ...shown(grant),
      primaryAction: { kind: "apply" },
      secondaryAction: viewGrant,
    };
  }

  // 3. The gate refuses a step — whatever an existing approval says.
  const needsRepair =
    blocks.length > 0 || rows.some((row) => row === "repair_required" || row === "input_required");
  if (needsRepair) {
    const action = repairAction(blocks[0], input.diagnosis?.is_current ?? false);
    return {
      ...base,
      state: "repair",
      facts: { ...facts, blockedStep: action.stepId },
      ...shown(grant),
      primaryAction: action,
      secondaryAction: viewGrant,
    };
  }

  // 4. Not verifiable is not approved.
  if (input.authorities === null || rows.includes("verification_unavailable")) {
    return { ...base, state: "unknown", facts, ...shown(null), primaryAction: null };
  }

  const inactive = workflow.lifecycle !== "active" || !workflow.current_version_id;
  const approvedFacts = grant
    ? {
        ...facts,
        validUntil: grant.valid_until,
        runsLeft: grant.remaining_runs,
        runsMax: grant.max_runs,
      }
    : facts;
  const approved = (): AutomationState => ({
    ...base,
    state: "approved",
    facts: approvedFacts,
    ...shown(grant),
    primaryAction: grant ? { kind: "view" } : null,
    secondaryAction: grant && grantNeedsExtension(grant, now) ? { kind: "extend" } : null,
  });

  // A workflow without a running version cannot run on its own, and cannot be
  // approved either: there is nothing to judge.
  if (inactive) {
    return {
      ...base,
      state: "manual",
      facts: { ...facts, inactive: true },
      ...shown(null),
      primaryAction: null,
    };
  }

  if (hasAutomation) {
    // The engine's verified answer decides where it is available: an approval
    // in the list that the status does not confirm is not one a run would use.
    const verified = rows.length > 0;
    const allAuthorized = verified && rows.every((row) => row === "authorized");
    if (verified ? allAuthorized : grant !== null) return approved();
    return { ...base, state: "grant", facts, ...shown(null), primaryAction: { kind: "grant" } };
  }

  // 6./7. Nothing starts it automatically.
  if (grant) return approved();
  return { ...base, state: "manual", facts, ...shown(null), primaryAction: { kind: "grant" } };
}

/**
 * The action that belongs beside the page title: the state's own next step
 * while one is pending. A calm state — approved, manual, unknown — offers none
 * there, and the title keeps its ordinary action.
 */
export function automationTitleAction(state: AutomationState): AutomationAction | null {
  if (state.state === "approved" || state.state === "manual" || state.state === "unknown")
    return null;
  return state.primaryAction;
}

/** What the reader may do — the rights the actions are gated by. */
export interface AutomationRights {
  /** `workflow:write`: approve, apply a saved change, resume, propose a repair. */
  write: boolean;
  /** `workflow:run`: run the trial that supplies missing evidence. */
  run: boolean;
  /** `conversation:write`: hand a block to an author in the chat. */
  chat: boolean;
}

/**
 * Whether the reader may perform an action. An action they may not perform is
 * not offered: a button that answers with a refusal is worse than none.
 */
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

/** The word for each state. */
export const AUTOMATION_STATE_KEYS = {
  paused: "automation.state.paused",
  apply: "automation.state.apply",
  repair: "automation.state.repair",
  unknown: "automation.state.unknown",
  grant: "automation.state.grant",
  approved: "automation.state.approved",
  manual: "automation.state.manual",
} satisfies Record<AutomationStateKind, TranslationKey>;

/** The label of an action — the same words wherever it is offered. */
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

/**
 * The same state in the vocabulary the chat's review card already uses
 * (`chatAutomationSummary`), so a card can be driven by this decision.
 */
export function automationSummary(
  state: AutomationStateKind,
): "authorized" | "repair" | "review" | "apply" | "unknown" {
  if (state === "approved") return "authorized";
  if (state === "repair") return "repair";
  if (state === "grant") return "review";
  if (state === "apply") return "apply";
  return "unknown";
}
