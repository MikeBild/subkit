// Authoring-time LLM critic — verdict + tool-output detail shapes.
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
//
// Plain zod (not `@hono/zod-openapi`) — these schemas are internal:
// they describe an LLM-boundary contract and a tool-output JSON shape,
// not an HTTP/MCP surface, so registering them as OpenAPI components
// would only pollute the generated spec.

import { z } from "zod";

export const REPAIRS_CAP = 5;
export const REPAIR_LENGTH_CAP = 400;
export const RATIONALE_LENGTH_CAP = 800;

/**
 * Verdict schema. Clamps rather than rejects when the LLM emits
 * more / longer items than the contract allows — an over-eager LLM
 * should not silently fail open. Each entry is truncated to
 * REPAIR_LENGTH_CAP; the list is sliced to REPAIRS_CAP; rationale
 * is truncated to RATIONALE_LENGTH_CAP.
 */
export const AuthoringCriticVerdictSchema = z.preprocess(
  (raw) => {
    if (raw === null || typeof raw !== "object") return raw;
    const r = raw as Record<string, unknown>;
    const repairsRaw = Array.isArray(r.repairs) ? r.repairs : undefined;
    const repairs = repairsRaw
      ?.filter((x): x is string => typeof x === "string" && x.length > 0)
      .slice(0, REPAIRS_CAP)
      .map((s) => (s.length > REPAIR_LENGTH_CAP ? s.slice(0, REPAIR_LENGTH_CAP) : s));
    const rationaleRaw = typeof r.rationale === "string" ? r.rationale : undefined;
    const rationale =
      rationaleRaw !== undefined && rationaleRaw.length > RATIONALE_LENGTH_CAP
        ? rationaleRaw.slice(0, RATIONALE_LENGTH_CAP)
        : rationaleRaw;
    return {
      ...r,
      ...(repairs !== undefined ? { repairs } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
    };
  },
  z.object({
    passed: z.boolean(),
    repairs: z.array(z.string().min(1).max(REPAIR_LENGTH_CAP)).max(REPAIRS_CAP),
    rationale: z.string().min(1).max(RATIONALE_LENGTH_CAP),
  }),
);

export type AuthoringCriticVerdict = z.infer<typeof AuthoringCriticVerdictSchema>;

/**
 * Shape of `details` on the `ok:false {error_code:"critic_rejected"}`
 * tool result. Single source of truth: build_workflow produces with
 * this shape, the conversation loop parses it for `prior_failures`.
 */
export const CriticRejectedDetailsSchema = z.object({
  repairs: z.array(z.string()).max(REPAIRS_CAP),
  rationale: z.string(),
  gating_reason: z.string().optional(),
});

export type CriticRejectedDetails = z.infer<typeof CriticRejectedDetailsSchema>;
