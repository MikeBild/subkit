import type { conversationElicitations } from "../db/schema/index.ts";

type Elicitation = typeof conversationElicitations.$inferSelect;

/** These questions have no tool call to carry their answer into the next turn. */
export function isProseQuestionElicitation(row: Elicitation): boolean {
  const input = row.input as { metadata?: { source?: unknown } } | null;
  return (
    row.tool_call_id === null &&
    row.tool_name === "ask_user_text" &&
    input?.metadata?.source === "loop.prose_question_parked"
  );
}

/** Text only: confirmations, forms and unanswered questions are never chat messages. */
export function proseQuestionAnswer(row: Elicitation): string | null {
  if (!isProseQuestionElicitation(row) || row.status !== "resolved") return null;
  const output = row.output as { value?: unknown } | null;
  return typeof output?.value === "string" ? output.value : null;
}
