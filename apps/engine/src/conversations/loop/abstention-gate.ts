// Whether a critic verdict may interrupt the human.
//
// A failed verdict asks the operator to confirm or revise, by raising an
// `ask_user_text` elicitation after the turn. Raising any elicitation cancels
// every pending one — a load-bearing rule, because the model must never see two
// open ask_user_* forms. So when the turn has ALREADY ended on the model's own
// question, raising the abstention silently replaces that question.
//
// In production it did exactly that: it cancelled a real choice the user was
// about to answer, substituted an untranslated internal prompt that no surface
// renders, and the user's typed answer was consumed by the invisible prompt —
// a whole turn lost. The verdict is logged in full regardless, so nothing is
// dropped by keeping it a note.

export type AbstentionDecision = "raise" | "skip_pending_question" | "none";

export function abstentionDecision(p: {
  commitAbstains: boolean;
  faithfulnessAbstains: boolean;
  /** True when the turn already ended on a pending human-facing question. */
  hasPendingQuestion: boolean;
}): AbstentionDecision {
  if (!p.commitAbstains && !p.faithfulnessAbstains) return "none";
  return p.hasPendingQuestion ? "skip_pending_question" : "raise";
}
