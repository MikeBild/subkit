import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationToolCalls } from "../../db/schema/index.ts";
import {
  listElicitationsForConversation,
  resolveElicitationAndReactivate,
} from "../elicitations.ts";

export type TaskRunQuestionCancelReason = "task_run_result_ready" | "task_run_ended";

const CANCEL_NOTES: Readonly<Record<TaskRunQuestionCancelReason, string>> = {
  task_run_result_ready:
    "the question was withdrawn because the result of the run is offered to the person for confirmation; nobody answered it. Do not ask again whether the result is right.",
  task_run_ended:
    "the question was withdrawn because the run ended; nobody answered it and nothing ran.",
};

function fieldsOf(input: unknown): { commit_intent?: unknown; question?: unknown } {
  return typeof input === "object" && input !== null ? input : {};
}

function staysOpen(
  elicitation: { tool_name: string; input: unknown },
  p: { keep_approvals: boolean; result_question: string | null },
): boolean {
  const input = fieldsOf(elicitation.input);
  if (input.commit_intent !== undefined) return p.keep_approvals;
  return (
    p.result_question !== null &&
    elicitation.tool_name === "ask_user_confirm" &&
    input.question === p.result_question
  );
}

export async function cancelOpenTaskRunQuestions(
  db: Db,
  p: {
    tenant_id: string;
    conversation_id: string;
    reason: TaskRunQuestionCancelReason;
    keep_approvals: boolean;
    result_question: string | null;
  },
): Promise<number> {
  const open = (await listElicitationsForConversation(p.tenant_id, p.conversation_id, db)).filter(
    (elicitation) => elicitation.status === "pending" && !staysOpen(elicitation, p),
  );
  const cancelled: string[] = [];
  for (const elicitation of open) {
    const resolution = await resolveElicitationAndReactivate(
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        id: elicitation.id,
        output: null,
        decided_by: null,
        reason: p.reason,
        status: "cancelled",
      },
      db,
    );
    if (resolution.kind === "resolved" && elicitation.tool_call_id)
      cancelled.push(elicitation.tool_call_id);
  }
  if (cancelled.length > 0)
    await db
      .update(conversationToolCalls)
      .set({
        output: { ok: false, abandoned: true, reason: p.reason, note: CANCEL_NOTES[p.reason] },
        outcome: "denied",
      })
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          inArray(conversationToolCalls.id, cancelled),
        ),
      );
  return open.length;
}
