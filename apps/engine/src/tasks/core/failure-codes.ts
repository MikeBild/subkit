export const TASK_RUN_FAILURE_CODES = [
  "turn_failed",
  "turn_interrupted",
  "start_failed",
  "playbook_tampered",
  "playbook_cancelled",
  "conversation_closed",
  "task_changed",
  "task_archived",
  "owner_unavailable",
  "budget_exhausted",
  "deadline_exceeded",
  "turn_limit_reached",
] as const;

export type TaskRunFailureCode = (typeof TASK_RUN_FAILURE_CODES)[number];

export function normalizeFailureCode(code: string): TaskRunFailureCode {
  const normalized = code.trim().toLowerCase();
  return TASK_RUN_FAILURE_CODES.find((known) => known === normalized) ?? "turn_failed";
}
