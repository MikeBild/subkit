export const TASK_RUN_RESULT_STEP_ID = "confirm-result";

export type PlaybookHandOver = "conversation" | "task_run";

export type TaskRunQuestionOutcome = "result_ready" | "ended";

export function stepHoldsDeliveredResult(progress: string, handOver: PlaybookHandOver): boolean {
  if (progress === "blocked") return true;
  return progress === "waiting_for_input" && handOver === "conversation";
}

export function normalizeTaskRunQuestion(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.?!…:;,]+$/u, "");
  return normalized === "" ? null : normalized;
}

export function asksForTheTaskRunResult(
  ask: { playbook_step_id?: unknown; question?: unknown },
  reserved: { goal: string | null; result_question: string | null },
): boolean {
  if (ask.playbook_step_id === TASK_RUN_RESULT_STEP_ID) return true;
  const asked = normalizeTaskRunQuestion(ask.question);
  if (asked === null) return false;
  return [reserved.goal, reserved.result_question].map(normalizeTaskRunQuestion).includes(asked);
}

export function taskRunQuestionStaysOpen(input: unknown, outcome: TaskRunQuestionOutcome): boolean {
  if (outcome !== "result_ready" || typeof input !== "object" || input === null) return false;
  return (input as { commit_intent?: unknown }).commit_intent !== undefined;
}
