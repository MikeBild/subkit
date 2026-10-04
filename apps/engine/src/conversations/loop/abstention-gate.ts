export type AbstentionDecision = "raise" | "skip_pending_question" | "none";

export function abstentionDecision(p: {
  commitAbstains: boolean;
  faithfulnessAbstains: boolean;
  hasPendingQuestion: boolean;
}): AbstentionDecision {
  if (!p.commitAbstains && !p.faithfulnessAbstains) return "none";
  return p.hasPendingQuestion ? "skip_pending_question" : "raise";
}
