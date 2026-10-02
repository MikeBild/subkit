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
//   0. legacy    the running version is stored in an earlier format: the
//                engine refuses to run, admit or approve it. Only a saved
//                change — the way out — is judged before it.
//   1. paused    every schedule and hook is stopped; nothing else matters.
//   2. apply     a saved change differs from the running version. Judging the
//                running version would describe problems the change may
//                already have solved.
//   3. repair    the gate refuses a step. This holds even while an approval
//                exists: the diagnosis includes the refused step of the newest
//                approved run ("the approval no longer fits").
//   4. unknown   the engine could not verify readiness, or a read the verdict
//                rests on did not answer. Never read as approved.
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
  | "legacy"
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
  /** The running version is stored in an earlier format and cannot run. */
  legacy?: boolean | null;
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
  /**
   * Reads that were made and did not answer. A failed read and a read the
   * reader may not make both leave `null` behind, and they are not the same:
   * without permission the state is decided from what remains; after a failure
   * "no block" and "no refusal" are guesses, and the state is `unknown`.
   */
  unanswered: { status: boolean; diagnosis: boolean };
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
  /**
   * The environments a decision is pending in, production first. One entry is
   * the ordinary case; two means starts in both halves of the installation
   * wait at once. Empty while nothing is pending.
   */
  pendingEnvironments: ReviewEnvironment[];
  /** The one action that moves the state forward. Null when there is none. */
  primaryAction: AutomationAction | null;
  /**
   * At most one further action: extending an approval that is running out, or
   * looking at an approval that is still valid while another step is pending.
   */
  secondaryAction: AutomationAction | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// The same thresholds the engine raises its attention item on
// (`apps/engine/src/workflows/authority-extension.ts`); the test pins them.
/** An approval is offered for extension this many days before it ends … */
export const EXTEND_WITHIN_DAYS = 3;
export const EXTEND_WITHIN_MS = EXTEND_WITHIN_DAYS * DAY_MS;
/** … or once fewer than this share of its runs is left. */
export const EXTEND_BELOW_RUN_SHARE = 0.1;

/**
 * Whether an approval admits a run of the running version right now. The
 * server's state already folds in a changed effect manifest; the local clock
 * may only narrow it.
 */
export function authorityIsLive(authority: WorkflowAuthority, now: number): boolean {
  return (
    authority.active_version &&
    authority.ready_for_new_run &&
    observedAuthorityState(authority, now) === "approved"
  );
}

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
  // The verified row leads; a schedule only the list knows is still one — two
  // reads of the same table taken a moment apart must not lose a trigger.
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

/** Production first: it is where an unattended run has real effects. */
function productionFirst(environments: Iterable<ReviewEnvironment>): ReviewEnvironment[] {
  const set = new Set(environments);
  return (["prod", "dev"] as const).filter((environment) => set.has(environment));
}

/** The environments of the verified rows that still wait for a decision. */
function pendingRowEnvironments(status: AutomationStatusLike | null): ReviewEnvironment[] {
  if (!status) return [];
  return productionFirst(
    [...status.schedules, ...status.inbound_hooks]
      .filter((row) => row.state !== "paused" && row.state !== "authorized")
      .map((row) => row.environment),
  );
}

/**
 * Without verified rows: the environments something starts the workflow in
 * that no current approval covers. The approvals list is then the only
 * evidence, and it has to cover every environment — an approval for
 * production says nothing about a schedule in development.
 */
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

/**
 * The environment automatic runs use, and so the one the approval and the
 * diagnosis are judged in: a hook's deliveries always run in production; a
 * schedule names its own; without either, the workflow's approvals say where
 * it belongs (`reviewEnvironment`). While a verified row still waits for a
 * decision, that row's environment leads.
 *
 * Needs only what the page reads before the diagnosis, so the diagnosis can be
 * asked for the right half of the installation.
 */
export function automationEnvironment(
  input: Pick<AutomationInputs, "workflow" | "schedules" | "status" | "authorities" | "now">,
): ReviewEnvironment {
  // Where something is still pending decides. With a schedule approved in
  // production and one waiting in development, naming production would say
  // "production is not approved" and open an approval that changes nothing.
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

/**
 * The act that removes one block of the gate diagnosis. A repair the engine
 * can compute is offered only for the running version: a saved change gets its
 * fix described, never proposed.
 */
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
  // The approval that covers the running version here and now.
  const live = (authority: WorkflowAuthority) => authorityIsLive(authority, now);
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

  // Where the pending step is decided: the verified rows that still wait, else
  // every environment something starts it in, else the one the state names.
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
  // While something else is pending, an approval that is still valid stays one
  // press away — for this environment or another: it is the evidence a reader
  // checks the pending step against, and the only place it can be revoked.
  const viewGrant: AutomationAction | null = authorities.some(live) ? { kind: "view" } : null;
  const facts = {
    version: workflow.current_version ?? null,
    preparedVersion: null,
    validUntil: null,
    runsLeft: null,
    runsMax: null,
    blockedStep: null,
    inactive: false,
  } satisfies AutomationState["facts"];

  // 0. The running version cannot run at all, whatever would start it and
  //    whatever was approved: it has to be saved again, and that is an
  //    author's act. A saved change that waits IS that act, and leads.
  if (workflow.legacy === true && target?.kind !== "prepared") {
    return {
      ...base,
      state: "legacy",
      facts,
      ...shown(null),
      pendingEnvironments: [],
      primaryAction: { kind: "repair", via: "chat", stepId: null },
      secondaryAction: viewGrant,
    };
  }

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
      pendingEnvironments: [],
      // A stopped hook cannot be switched back on from here — the engine has
      // no such act — so a hook-only workflow gets a hint and no button.
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
      // The change is new everywhere it will run.
      pendingEnvironments: startedIn.length > 0 ? startedIn : [environment],
      primaryAction: { kind: "apply" },
      secondaryAction: viewGrant,
    };
  }

  // 3. The gate refuses a step — whatever an existing approval says.
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

  // 4. Not verifiable is not approved — and not calm either: when neither
  //    read of the schedules answered, "nothing starts it" is a guess. The
  //    same holds for a read that failed: an unread diagnosis is not "no
  //    block", and an unread status is not "nothing refused".
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

  // A workflow without a running version cannot run on its own, and cannot be
  // approved either: there is nothing to judge.
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
    // The engine's verified answer decides where it is available: an approval
    // in the list that the status does not confirm is not one a run would use.
    const verified = rows.length > 0;
    const allAuthorized = verified && rows.every((row) => row === "authorized");
    // A hook the reader may not list is judged by no row. Its deliveries run
    // in production: an authorized production row answers for it (the same
    // version, the same approval); authorized development rows do not.
    const hookUnverified =
      hiddenHooks &&
      allAuthorized &&
      !(input.status?.schedules ?? []).some(
        (row) => row.environment === "prod" && row.state === "authorized",
      );
    // No approval for production in the list: the hook has none. One in the
    // list that no row confirms is neither — say so rather than guess.
    if (hookUnverified) return grant ? unknown() : needsGrant();
    if (verified ? allAuthorized : grant !== null) return approved();
    return needsGrant();
  }

  // 6./7. Nothing starts it automatically.
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

/**
 * Whether the approval the state rests on is still out of sight: the engine
 * confirms every start is approved, but the approval is not among the ones
 * read so far. The list arrives newest first, a page at a time — an approval
 * older than a page of later ones is still the one in force, and "approved"
 * without its end and its runs would be a claim with nothing behind it.
 */
export function automationNeedsMoreApprovals(
  state: Pick<AutomationState, "state" | "grant">,
  hasMore: boolean,
): boolean {
  return hasMore && state.state === "approved" && state.grant === null;
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
  legacy: "automation.state.legacy",
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
 * What the chat's review card says and offers — the page's own next step.
 *
 *   review   open the approval dialog, once per pending environment
 *   resume   resume the paused schedules — the panel's own act
 *   recheck  read the state again: it could not be verified
 *   none     nothing to press: approved, on request, or a stopped hook
 */
export interface AutomationCard {
  titleKey: TranslationKey;
  hintKey: TranslationKey;
  act: "review" | "resume" | "recheck" | "none";
  /** The label of the one button, while a single environment is pending. */
  actionKey: TranslationKey;
  /** The environments to decide in, production first. Empty unless `review`. */
  environments: ReviewEnvironment[];
}

/**
 * The review card for a state. A pending decision gives one button named for
 * the step (two only when both environments wait); every other state says
 * what the page says and offers what the page offers — never the approval
 * dialog for a workflow that is paused, on request or simply not verified.
 * What an approval would allow is said for what really starts the workflow: a
 * schedule, a webhook, or both.
 */
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
    case "legacy":
      // Changing the workflow happens in a conversation — this one.
      return {
        ...calm,
        titleKey: AUTOMATION_STATE_KEYS.legacy,
        hintKey: "automation.headline.legacy",
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
        // Only a hook is stopped: said, with nothing to press.
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
