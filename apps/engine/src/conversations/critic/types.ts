// Authoring-time LLM critic — verdict shape.
//
// Distinct from the deterministic end-of-turn rubric at
// `apps/engine/src/llm/critic/` which grades terminal artifacts.
// This critic runs *during* authoring, on a workflow draft that has
// already cleared every static gate (verifier, cycles, refs, loop
// authoring), and surfaces semantic-class drift (step order,
// `output_transform` typing, idempotency assumptions) as repair hints
// the next conversation turn picks up via `prior_failures`.
//
// Invariant: the verdict NEVER mutates the draft. A failed verdict
// makes the build tool return `ok:false` with the repair list; the LLM
// re-authors on the next turn.

import { z } from "@hono/zod-openapi";

export const AuthoringCriticVerdictSchema = z
  .object({
    passed: z.boolean(),
    repairs: z.array(z.string().min(1).max(400)).max(5),
    rationale: z.string().min(1).max(800),
  })
  .openapi("AuthoringCriticVerdict");

export type AuthoringCriticVerdict = z.infer<typeof AuthoringCriticVerdictSchema>;
