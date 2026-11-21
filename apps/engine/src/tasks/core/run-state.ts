import type { TaskRunState, TaskRunWaitingReason } from "../types.ts";
import { normalizeFailureCode, type TaskRunFailureCode } from "./failure-codes.ts";
import type { TaskPlaybookFacts } from "./plan-instance.ts";
import { taskRunProgress } from "./progress.ts";

export const TASK_NO_PROGRESS_LIMIT = 2;
export const TASK_TURN_STOPPED = "turn_stopped";
export const TASK_TURN_FAILURES_BEFORE_THE_MODEL: readonly string[] = [
  "llm_spend_limit_reached",
  "ai_access_missing",
];
export const TASK_SLEEP_REASONS = ["paused", "check_requested", "provider_throttled"] as const;
export type TaskSleepReason = (typeof TASK_SLEEP_REASONS)[number];

export interface TaskRunObservation {
  conversation_status: "active" | "awaiting_input" | "committed" | "abandoned" | "missing";
  pending_elicitation: "question" | "approval" | "question_expired" | null;
  playbook: TaskPlaybookFacts | null;
  requested_check_at: Date | null;
  turn_id: string | null;
  turn_seq: number | null;
  turn_driver: "task" | "person";
  turn_failure: { code: string; retry_at: Date | null } | null;
  turn_interrupted: boolean;
  human_input_since_last_turn: boolean;
  progress_marks: readonly string[];
  result_confirmed_by: string | null;
  result_rejected: boolean;
}

export interface TaskRunProgress {
  turns_used: number;
  no_progress_count: number;
  last_playbook_revision: number;
  progress_marks: readonly string[];
  last_seen_turn_seq: number;
  rejected_playbook_revision: number | null;
  deadline_at: Date;
}

export interface TaskRunDecision {
  state: TaskRunState;
  waiting_reason: TaskRunWaitingReason | null;
  next_check_at: Date | null;
  sleep_reason: TaskSleepReason | null;
  enqueue: boolean;
  failure_code: TaskRunFailureCode | null;
  turns_used: number;
  no_progress_count: number;
  last_playbook_revision: number;
  progress_marks: string[];
  last_seen_turn_seq: number;
  turn_seen: boolean;
}

function within(at: Date, now: Date, deadline: Date): Date {
  const earliest = at > now ? at : now;
  return earliest < deadline ? earliest : deadline;
}

export type TaskRunLimitCode = "turn_limit_reached" | "deadline_exceeded";

export function taskRunLimitCode(
  run: Pick<TaskRunProgress, "turns_used" | "deadline_at">,
  limits: { max_turns: number },
  now: Date,
): TaskRunLimitCode | null {
  if (run.turns_used >= limits.max_turns) return "turn_limit_reached";
  return run.deadline_at <= now ? "deadline_exceeded" : null;
}

export function taskRunLimitReached(
  run: Pick<TaskRunProgress, "turns_used" | "deadline_at">,
  limits: { max_turns: number },
  now: Date,
): boolean {
  return taskRunLimitCode(run, limits, now) !== null;
}

export function decideTaskRunState(
  observation: TaskRunObservation,
  run: TaskRunProgress,
  limits: { max_turns: number },
  now: Date,
): TaskRunDecision {
  const playbook = observation.playbook;
  const revision = playbook?.revision ?? run.last_playbook_revision;
  const seq = observation.turn_seq;
  const stale = seq !== null && seq <= run.last_seen_turn_seq;
  const turn = observation.turn_id !== null && !stale;
  const failure = stale ? null : observation.turn_failure;
  const unbilled = failure !== null && TASK_TURN_FAILURES_BEFORE_THE_MODEL.includes(failure.code);
  const counted = turn && observation.turn_driver === "task" && !unbilled;
  const turns_used = run.turns_used + (counted ? 1 : 0);
  const { progress_marks, progressed } = taskRunProgress(
    run.progress_marks,
    observation.progress_marks,
  );
  const check =
    observation.requested_check_at && observation.requested_check_at > now
      ? observation.requested_check_at
      : null;
  const no_progress_count =
    progressed || observation.human_input_since_last_turn || check
      ? 0
      : run.no_progress_count + (turn ? 1 : 0);
  const counters = {
    turns_used,
    no_progress_count,
    last_playbook_revision: revision,
    progress_marks,
    last_seen_turn_seq: turn && seq !== null ? seq : run.last_seen_turn_seq,
    turn_seen: turn,
  };
  const settle = (
    state: TaskRunState,
    extra: Partial<
      Pick<TaskRunDecision, "waiting_reason" | "next_check_at" | "sleep_reason" | "failure_code">
    > = {},
  ): TaskRunDecision => ({
    state,
    waiting_reason: null,
    next_check_at: null,
    sleep_reason: null,
    failure_code: null,
    ...extra,
    enqueue: state === "running",
    ...counters,
  });
  const sleep = (at: Date, sleep_reason: TaskSleepReason) =>
    settle("sleeping", { next_check_at: within(at, now, run.deadline_at), sleep_reason });
  const rejected = observation.result_rejected || revision === run.rejected_playbook_revision;
  if (
    observation.conversation_status === "missing" ||
    observation.conversation_status === "abandoned"
  )
    return settle("failed", { failure_code: "conversation_closed" });
  if (!playbook?.intact || (playbook.status === "completed" && !playbook.result_confirmed))
    return settle("failed", { failure_code: "playbook_tampered" });
  if (playbook.status === "completed")
    return settle(observation.result_confirmed_by ? "completed" : "result_ready");
  if (playbook.status === "cancelled")
    return settle("failed", { failure_code: "playbook_cancelled" });
  if ((playbook.status === "prepared" || playbook.awaiting_result_confirmation) && !rejected)
    return settle("result_ready");
  if (observation.pending_elicitation)
    return settle("waiting", { waiting_reason: observation.pending_elicitation });
  if (failure?.code === "llm_spend_limit_reached")
    return settle("waiting", { waiting_reason: "budget" });
  if (failure?.code === "ai_access_missing")
    return settle("waiting", { waiting_reason: "ai_access" });
  if (failure?.code === TASK_TURN_STOPPED)
    return settle("waiting", { waiting_reason: "turn_stopped" });
  if (failure && !failure.retry_at)
    return settle("failed", { failure_code: normalizeFailureCode(failure.code) });
  if (observation.turn_interrupted && !stale)
    return settle("failed", { failure_code: "turn_interrupted" });
  const limit = taskRunLimitCode({ turns_used, deadline_at: run.deadline_at }, limits, now);
  if (limit) return settle("failed", { failure_code: limit });
  if (failure?.retry_at) return sleep(failure.retry_at, "provider_throttled");
  if (check) return sleep(check, "check_requested");
  if (no_progress_count >= TASK_NO_PROGRESS_LIMIT)
    return settle("waiting", { waiting_reason: "no_progress" });
  return settle("running");
}

export type TaskRunResumeDecision =
  | { resume: true; no_progress_count: number }
  | { resume: false; failure_code: TaskRunLimitCode };

export function decideTaskRunResume(
  run: TaskRunProgress & { state: TaskRunState },
  limits: { max_turns: number },
  now: Date,
): TaskRunResumeDecision {
  const limit = taskRunLimitCode(run, limits, now);
  if (limit) return { resume: false, failure_code: limit };
  return { resume: true, no_progress_count: run.state === "waiting" ? 0 : run.no_progress_count };
}

export function taskRunIsOpen(state: TaskRunState): boolean {
  return state === "running" || state === "waiting" || state === "sleeping";
}

export { normalizeFailureCode };
