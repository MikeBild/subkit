import { type ReviewTarget, reviewTarget } from "./workflow-review-target.ts";

export type ReviewEnvironment = "dev" | "prod";
export interface WorkflowAuthority {
  execution_environment: ReviewEnvironment;
  active_version: boolean;
  ready_for_new_run: boolean;
  state:
    | "approved"
    | "not_yet_valid"
    | "expired"
    | "revoked"
    | "superseded"
    | "exhausted"
    | "invalidated"
    | "unavailable";
  valid_from: string;
  valid_until: string | null;
  revoked_at: string | null;
  remaining_runs: number | null;
  max_runs: number | null;
  reserved_runs: number;
}
export interface GateDiagnosis {
  subject: { step_id: string | null };
  fixer?: unknown;
  candidate_id?: string | null;
  remedy_kind: string;
}

function observedAuthorityState(authority: WorkflowAuthority, now: number) {
  if (authority.state !== "approved") return authority.state;
  const until = authority.valid_until === null ? null : Date.parse(authority.valid_until);
  const from = Date.parse(authority.valid_from);
  if ((until !== null && !Number.isFinite(until)) || !Number.isFinite(from)) return "unavailable";
  if (until !== null && until <= now) return "expired";
  if (from > now) return "not_yet_valid";
  if (authority.remaining_runs !== null && authority.remaining_runs <= 0) return "exhausted";
  return authority.state;
}

function reviewEnvironment(
  authorities: readonly WorkflowAuthority[],
  _hold: undefined,
  now: Date,
): ReviewEnvironment {
  for (const authority of authorities) {
    if (authority.revoked_at) continue;
    if (authority.valid_until && Date.parse(authority.valid_until) <= now.getTime()) continue;
    return authority.execution_environment;
  }
  return authorities[0]?.execution_environment ?? "dev";
}

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

export interface AutomationInputs<A extends WorkflowAuthority = WorkflowAuthority> {
  workflow: AutomationWorkflow;
  draft?: { version_id: string; version: number } | null;
  schedules: readonly ScheduleLike[] | null;
  status: AutomationStatusLike | null;
  authorities: readonly A[] | null;
  diagnosis: { is_current: boolean; diagnoses: readonly GateDiagnosis[] } | null;
  unanswered: { status: boolean; diagnosis: boolean };
  connectorEnvironment?: ReviewEnvironment | null;
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

export interface AutomationState<A extends WorkflowAuthority = WorkflowAuthority> {
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
  grant: A | null;
  alsoValid: A[];
  history: A[];
  triggers: AutomationTrigger[];
  pendingEnvironments: ReviewEnvironment[];
  primaryAction: AutomationAction | null;
  secondaryAction: AutomationAction | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXTEND_WITHIN_DAYS = 3;
const EXTEND_WITHIN_MS = EXTEND_WITHIN_DAYS * DAY_MS;
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

function automationTriggers(
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

export type EnvironmentContextReason = "schedule" | "inbound_hook" | "existing_approval";

export interface EnvironmentDecision {
  environment: ReviewEnvironment;
  reason: EnvironmentContextReason;
}

interface EnvironmentSource {
  environment: ReviewEnvironment;
  kind: "schedule" | "hook";
}

function sourceDecision(
  environment: ReviewEnvironment,
  sources: readonly EnvironmentSource[],
): EnvironmentDecision {
  return {
    environment,
    reason: sources.some(
      (source) => source.environment === environment && source.kind === "schedule",
    )
      ? "schedule"
      : "inbound_hook",
  };
}

function pendingRowSources(status: AutomationStatusLike | null): EnvironmentSource[] {
  if (!status) return [];
  return [
    ...status.schedules
      .filter((row) => row.state !== "paused" && row.state !== "authorized")
      .map((row) => ({ environment: row.environment, kind: "schedule" as const })),
    ...status.inbound_hooks
      .filter((row) => row.state !== "paused" && row.state !== "authorized")
      .map((row) => ({ environment: row.environment, kind: "hook" as const })),
  ];
}

function pendingRowEnvironments(status: AutomationStatusLike | null): ReviewEnvironment[] {
  return productionFirst(pendingRowSources(status).map((source) => source.environment));
}

function startedSources(
  input: Pick<AutomationInputs, "workflow" | "schedules">,
): EnvironmentSource[] {
  return [
    ...automationTriggers(null, input.schedules)
      .filter((trigger) => !trigger.paused)
      .map((trigger) => ({ environment: trigger.environment, kind: trigger.kind })),
    ...((input.workflow.webhooks_active ?? 0) > 0
      ? [{ environment: "prod" as const, kind: "hook" as const }]
      : []),
  ];
}

function uncoveredEnvironments(
  input: Pick<AutomationInputs, "workflow" | "schedules" | "status" | "authorities" | "now">,
): ReviewEnvironment[] {
  if (input.status) return [];
  const started = productionFirst(startedSources(input).map((source) => source.environment));
  return started.filter(
    (environment) =>
      !(input.authorities ?? []).some(
        (authority) =>
          authority.execution_environment === environment && authorityIsLive(authority, input.now),
      ),
  );
}

type EnvironmentInputs = Pick<
  AutomationInputs,
  "workflow" | "schedules" | "status" | "authorities" | "now" | "connectorEnvironment"
>;

export function automationEnvironmentDecision(
  input: Omit<EnvironmentInputs, "connectorEnvironment">,
): EnvironmentDecision | null {
  const pendingRows = pendingRowEnvironments(input.status);
  const [pending] = [...pendingRows, ...uncoveredEnvironments(input)];
  if (pending)
    return sourceDecision(
      pending,
      pendingRows.includes(pending) ? pendingRowSources(input.status) : startedSources(input),
    );
  const triggers = automationTriggers(input.status, input.schedules);
  const running = triggers.filter((trigger) => !trigger.paused);
  const pool = running.length > 0 ? running : triggers;
  if (pool.some((trigger) => trigger.environment === "prod")) return sourceDecision("prod", pool);
  if ((input.workflow.webhooks_active ?? 0) > 0)
    return { environment: "prod", reason: "inbound_hook" };
  if (pool.length > 0) return sourceDecision("dev", pool);
  if (input.authorities !== null && input.authorities.length > 0)
    return {
      environment: reviewEnvironment(input.authorities, undefined, new Date(input.now)),
      reason: "existing_approval",
    };
  return null;
}

function decidedEnvironment(input: EnvironmentInputs): ReviewEnvironment | null {
  if (input.authorities === null) {
    const decided = automationEnvironmentDecision(input);
    return decided ? decided.environment : "dev";
  }
  return automationEnvironmentDecision(input)?.environment ?? null;
}

export function automationEnvironmentUndecided(input: EnvironmentInputs): boolean {
  return decidedEnvironment(input) === null;
}

export function automationEnvironment(input: EnvironmentInputs): ReviewEnvironment {
  return decidedEnvironment(input) ?? input.connectorEnvironment ?? "dev";
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

export function automationState<A extends WorkflowAuthority>(
  input: AutomationInputs<A>,
): AutomationState<A> {
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
  const shown = (current: A | null) => {
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
  } satisfies Partial<AutomationState<A>>;
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

  const unknown = (): AutomationState<A> => ({
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
  const approved = (): AutomationState<A> => ({
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

  const needsGrant = (): AutomationState<A> => ({
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
