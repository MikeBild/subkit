// Single source of truth for the `next_suggestion` SSE frame's
// `reason` field. Lives in `packages/shared/` so the engine, sk-cli,
// cli-core, and any future consumer all import the same literal-typed
// array — drift between the TurnEvent union, the Zod schema, the
// frame builder, the service return type, and the client mirror is
// caught at typecheck instead of going silent in production.
//
// Adding a new reason: append it to this array. The corresponding
// Zod schema (z.enum) and the union type below pick it up
// automatically. The metric label cardinality is bounded by this
// array's length.

export const SUGGEST_NEXT_REASONS = [
  "offer-detected",
  "offer-skill",
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
