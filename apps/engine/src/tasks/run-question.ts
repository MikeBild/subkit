import { z } from "@hono/zod-openapi";
import { listElicitationsForConversation } from "../conversations/public/elicitation.ts";
import type { Executor } from "../db/client.ts";
import { type TaskRun, TaskRunSchema } from "./types.ts";

export const TASK_RUN_QUESTION_MAX_LENGTH = 300;

export const TaskRunDetailSchema = z
  .object({
    ...TaskRunSchema.shape,
    pending_question: z.string().max(TASK_RUN_QUESTION_MAX_LENGTH).nullable(),
  })
  .openapi("TaskRunDetail");

export type TaskRunDetail = z.infer<typeof TaskRunDetailSchema>;

export async function readTaskRunPendingQuestion(
  db: Executor,
  tenant_id: string,
  run: Pick<TaskRun, "state" | "waiting_reason" | "conversation_id">,
): Promise<string | null> {
  if (run.state !== "waiting" || run.waiting_reason !== "question" || !run.conversation_id)
    return null;
  const open = (await listElicitationsForConversation(tenant_id, run.conversation_id, db)).find(
    (elicitation) => elicitation.status === "pending",
  );
  const text = open?.summary.trim();
  if (!text) return null;
  return text.length > TASK_RUN_QUESTION_MAX_LENGTH
    ? `${text.slice(0, TASK_RUN_QUESTION_MAX_LENGTH - 1)}…`
    : text;
}
