export const EVAL_RESERVED = {
  goal: "Summarize the open support tickets of this week",
  result_question: "Does this summary meet your expectations?",
} as const;

export const RESULT_QUESTION_PARAPHRASES: readonly string[] = [
  "Is this summary what you expected?",
  "Does the summary look right to you?",
  "Are you happy with the result?",
  "Can you confirm the summary is correct?",
  "Shall I treat the ticket summary as final?",
  "Is the goal reached with this summary?",
  "Does this cover everything you wanted from the weekly ticket summary?",
  "Would you approve this summary of the open tickets?",
  "Is anything wrong with the result, or can I hand it over?",
  "Did I get the summary of this week's open tickets right?",
  "Is the work done to your satisfaction?",
  "Please confirm: is this the summary you asked for?",
];

export const NON_RESULT_QUESTIONS: readonly string[] = [
  "Which support queue should I read the tickets from?",
  "Should tickets closed today count as open?",
  "Which time zone does the week start in?",
  "May I send the summary to the team channel?",
  "Do you want the tickets grouped by priority or by customer?",
  "The ticket system rejected the token. Can you renew the connection?",
  "How many tickets at most should the summary list?",
  "Should I include tickets without an assignee?",
  "Which language should the summary be written in?",
  "Is the board named Support the right one to read from?",
];
