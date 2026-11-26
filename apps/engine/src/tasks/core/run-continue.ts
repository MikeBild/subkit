import type { TaskRunState, TaskRunWaitingReason } from "../types.ts";
import { taskRunHeldForPerson } from "./run-state.ts";

export type TaskRunContinuationRefusal = "not_owner" | "not_held" | "paused";

export type TaskRunContinuationAdmission =
  | { ok: true }
  | { ok: false; reason: TaskRunContinuationRefusal };

interface HeldRun {
  state: TaskRunState;
  waiting_reason: TaskRunWaitingReason | null;
  conversation_id: string | null;
}

export function decideTaskRunContinuation(input: {
  run: HeldRun;
  owner_id: string;
  person_id: string;
  task_paused: boolean;
}): TaskRunContinuationAdmission {
  if (input.person_id !== input.owner_id) return { ok: false, reason: "not_owner" };
  if (!taskRunHeldForPerson(input.run) || input.run.conversation_id === null)
    return { ok: false, reason: "not_held" };
  if (input.task_paused) return { ok: false, reason: "paused" };
  return { ok: true };
}

export function taskRunStillHeldBy(run: HeldRun, conversation_id: string): boolean {
  return taskRunHeldForPerson(run) && run.conversation_id === conversation_id;
}

export function taskRunReattachment(p: {
  conversation_id: string;
  playbook_revision: number;
  no_progress_count: number;
}) {
  return {
    conversation_id: p.conversation_id,
    state: "running" as const,
    waiting_reason: null,
    next_check_at: null,
    sleep_reason: null,
    no_progress_count: p.no_progress_count,
    last_seen_turn_id: null,
    last_seen_turn_seq: 0,
    last_playbook_revision: p.playbook_revision,
    rejected_playbook_revision: null,
    turn_job_failures: 0,
  };
}
