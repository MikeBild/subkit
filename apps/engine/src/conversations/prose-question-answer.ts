import type { conversationElicitations } from "../db/schema/index.ts";

type Elicitation = typeof conversationElicitations.$inferSelect;

/** These questions have no tool call to carry their answer into the next turn. */
export function isProseQuestionElicitation(
  row: Pick<Elicitation, "tool_call_id" | "tool_name" | "input">,
): boolean {
  const input = row.input as { metadata?: { source?: unknown } } | null;
  return (
    row.tool_call_id === null &&
    row.tool_name === "ask_user_text" &&
    input?.metadata?.source === "loop.prose_question_parked"
  );
}

/** Text only: confirmations, forms and unanswered questions are never chat messages. */
export function proseQuestionAnswer(row: Elicitation): string | null {
  return isProseQuestionElicitation(row) ? resolvedTextAnswer(row) : null;
}

export function resolvedTextAnswer(
  row: Pick<Elicitation, "tool_name" | "status" | "output">,
): string | null {
  if (row.tool_name !== "ask_user_text" || row.status !== "resolved") return null;
  const output = row.output as { value?: unknown } | null;
  return typeof output?.value === "string" ? output.value : null;
}

/** Show the declared label of a completed selection, never its machine value. */
export function resolvedChoiceAnswer(
  row: Pick<Elicitation, "tool_name" | "status" | "input" | "output">,
): string | null {
  if (row.tool_name !== "ask_user_choice" || row.status !== "resolved") return null;
  const output = row.output as { value?: unknown } | null;
  const input = row.input as { options?: unknown } | null;
  if (typeof output?.value !== "string" || !Array.isArray(input?.options)) return null;
  const option = input.options.find((item) => item?.value === output.value);
  return typeof option?.label === "string" ? option.label : null;
}
