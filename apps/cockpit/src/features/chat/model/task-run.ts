import { type TaskRun, waitingParty, waitingStateKey } from "@/features/tasks";
import type { Translate } from "@/lib/i18n";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
import type { ConversationPlaybook, PlaybookStep } from "./playbook";

export type TaskRunState = TaskRun["state"];

export const RUN_CONFIRM_STEP_ID = "confirm-result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunMarker {
  taskId: string | null;
  taskRunId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

export const RUN_CONTINUATION_ORIGIN = "task_run_continuation";

export function isRunContinuation(message: unknown): boolean {
  return record(message)?.origin === RUN_CONTINUATION_ORIGIN;
}

export function runMarker(draft: unknown): RunMarker | null {
  const session = record(record(draft)?.session);
  if (!session || !Object.hasOwn(session, "task_run")) return null;
  const marker = record(session.task_run);
  const taskId = uuid(marker?.task_id);
  const taskRunId = uuid(marker?.task_run_id);
  return taskId && taskRunId ? { taskId, taskRunId } : { taskId: null, taskRunId: null };
}

const STATE_KEYS = {
  running: "chat.taskRun.state.running",
  waiting: "chat.taskRun.state.waiting",
  sleeping: "chat.taskRun.state.sleeping",
  result_ready: "chat.taskRun.state.result_ready",
  completed: "chat.taskRun.state.completed",
  aborted: "chat.taskRun.state.aborted",
  failed: "chat.taskRun.state.failed",
} as const satisfies Record<TaskRunState, TranslationKey>;

const BADGE_STATES = {
  running: "running",
  waiting: "awaiting_input",
  sleeping: "pending",
  result_ready: "pending",
  completed: "completed",
  aborted: "aborted",
  failed: "failed",
} as const satisfies Record<TaskRunState, string>;

export function runStateKey(state: string): TranslationKey | null {
  return Object.hasOwn(STATE_KEYS, state) ? STATE_KEYS[state as TaskRunState] : null;
}

export function runBadgeState(state: string): string {
  return Object.hasOwn(BADGE_STATES, state) ? BADGE_STATES[state as TaskRunState] : "pending";
}

const OPEN_STATES: readonly string[] = ["running", "waiting", "sleeping"];

export function runIsOpen(state: string): boolean {
  return OPEN_STATES.includes(state);
}

export function runCanAbort(state: string, permissions: readonly string[]): boolean {
  return runIsOpen(state) && permissions.includes("task_run:abort");
}

const SETTLED_STEPS: readonly PlaybookStep["status"][] = [
  "verified",
  "assessment_ready",
  "not_applicable",
];

function workSteps(playbook: ConversationPlaybook): PlaybookStep[] {
  return playbook.steps.filter((step) => step.id !== RUN_CONFIRM_STEP_ID);
}

export function runNowStep(
  playbook: ConversationPlaybook | null,
  state: string,
  t: Translate,
  waitingReason?: string | null,
): string | null {
  if (!playbook || state === "completed" || state === "aborted" || state === "failed") return null;
  const waits = state === "waiting";
  if (waits && waitingParty({ state, waiting_reason: waitingReason }) !== "you") return null;
  const work = workSteps(playbook);
  const current =
    work.find((step) => step.status === "in_progress") ??
    work.find((step) => step.status === "waiting_for_input") ??
    (waits ? undefined : work.find((step) => !SETTLED_STEPS.includes(step.status)));
  if (current) return current.label.trim() || null;
  if (waits) return playbook.next_action?.label.trim() || null;
  return playbook.steps.some((step) => step.id === RUN_CONFIRM_STEP_ID)
    ? t("chat.taskRun.confirm.label")
    : null;
}

function goalInQuotes(goal: string): string {
  return goal.trim().replace(/[.!?…]+$/u, "");
}

const RUN_STATUS = {
  running: null,
  sleeping: null,
  waiting: "waiting_for_input",
  result_ready: "waiting_for_input",
  completed: "completed",
  aborted: "cancelled",
  failed: "blocked",
} as const satisfies Record<TaskRunState, ConversationPlaybook["status"] | null>;

function runStatus(
  state: string | null | undefined,
  derived: ConversationPlaybook["status"],
): ConversationPlaybook["status"] {
  if (!state || !Object.hasOwn(RUN_STATUS, state)) return derived;
  const fixed = RUN_STATUS[state as TaskRunState];
  if (fixed) return fixed;
  return derived === "completed" || derived === "cancelled" ? "in_progress" : derived;
}

function confirmStatus(
  state: string | null | undefined,
  stored: PlaybookStep["status"],
): PlaybookStep["status"] {
  if (state === "completed") return "verified";
  if (state === "result_ready") return "waiting_for_input";
  if (stored === "blocked") return "open";
  return state && stored === "verified" ? "open" : stored;
}

export function runPlaybook(
  playbook: ConversationPlaybook,
  t: Translate,
  state?: string | null,
): ConversationPlaybook {
  const confirm = playbook.steps.find((step) => step.id === RUN_CONFIRM_STEP_ID);
  if (!confirm) return playbook;
  const work = workSteps(playbook);
  const notYet = confirm.status === "blocked";
  const onlyConfirmBlocks =
    playbook.status === "blocked" && !work.some((step) => step.status === "blocked");
  const derived: ConversationPlaybook["status"] = onlyConfirmBlocks
    ? work.some(
        (step) =>
          step.status === "in_progress" ||
          step.status === "verified" ||
          step.status === "assessment_ready",
      )
      ? "in_progress"
      : "open"
    : playbook.status;
  const done = state === "completed";
  const completion = state
    ? { ...playbook.completion, status: done ? ("verified" as const) : ("open" as const) }
    : playbook.completion;
  return {
    ...playbook,
    status: runStatus(state, derived),
    completion,
    summary:
      playbook.summary === `${confirm.label}: ${confirm.criterion}`
        ? t("chat.taskRun.summary.working")
        : playbook.summary,
    steps: playbook.steps.map((step) =>
      step.id === RUN_CONFIRM_STEP_ID
        ? {
            ...step,
            label: t("chat.taskRun.confirm.label"),
            criterion: t("chat.taskRun.confirm.question", { goal: goalInQuotes(playbook.goal) }),
            status: confirmStatus(state, step.status),
            reason: notYet ? (done ? "" : t("chat.taskRun.confirm.notYet")) : step.reason,
          }
        : step,
    ),
  };
}

export function newerPlaybook(
  conversation: { playbook: ConversationPlaybook | null; at: number },
  refreshed: { playbook: ConversationPlaybook | null | undefined; at: number },
): ConversationPlaybook | null {
  return refreshed.playbook === undefined || refreshed.at < conversation.at
    ? conversation.playbook
    : refreshed.playbook;
}

function localDay(value: Date, zone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zone,
  }).format(value);
}

export function runDateLabel(locale: Locale, iso: string, zone?: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat(
    LOCALE_TAGS[locale],
    locale === "de"
      ? { day: "2-digit", month: "2-digit", timeZone: zone }
      : { day: "numeric", month: "short", timeZone: zone },
  ).format(at);
}

export function runCheckLabel(
  locale: Locale,
  iso: string | null | undefined,
  now: number,
  zone?: string,
): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = localDay(at, zone) === localDay(new Date(now), zone);
  return new Intl.DateTimeFormat(
    LOCALE_TAGS[locale],
    sameDay
      ? { timeStyle: "short", timeZone: zone }
      : { dateStyle: "short", timeStyle: "short", timeZone: zone },
  ).format(at);
}

export interface RunLine {
  state: { label: string; badge: string } | null;
  facts: string[];
}

export function runLine(
  input: {
    run: Pick<TaskRun, "state" | "next_check_at"> & { waiting_reason?: string | null };
    playbook: ConversationPlaybook | null;
    now: number;
    zone?: string;
  },
  locale: Locale,
  t: Translate,
): RunLine {
  const waiting = waitingStateKey(input.run);
  const stateKey = waiting ?? runStateKey(input.run.state);
  const step = runNowStep(input.playbook, input.run.state, t, input.run.waiting_reason);
  const check = runIsOpen(input.run.state)
    ? runCheckLabel(locale, input.run.next_check_at, input.now, input.zone)
    : null;
  return {
    state: stateKey
      ? { label: t(stateKey), badge: waiting ? "pending" : runBadgeState(input.run.state) }
      : null,
    facts: [
      ...(step ? [t("chat.taskRun.now", { step })] : []),
      ...(check ? [t("chat.taskRun.nextCheck", { time: check })] : []),
    ],
  };
}
