export const SUGGEST_NEXT_REASONS = [
  "offer-detected",
  "offer-skill",
  "capability-gap",
  "model",
  "early-conversation",
  "client-suppress",
  "filtered",
  "empty",
  "budget-pressure",
  "turn-abandoned",
  "error",
] as const;

export type SuggestNextReason = (typeof SUGGEST_NEXT_REASONS)[number];

export const SUGGEST_NEXT_KINDS = ["text", "slash"] as const;
export type SuggestNextKind = (typeof SUGGEST_NEXT_KINDS)[number];
