// chat critic rubric.
//
// Triggered on plain conversational terminals (no commit, no propose)
// to keep ungrounded claims out of the user-visible answer. Asks the
// tenant-default model to verdict-check the assistant's final text
// against:
//
//   1. Are referenced connector / workflow ids present in the tenant
//      snapshot (no invented identifiers)?
//   2. Are quoted runtime values (engine_url, tenant_slug) consistent
//      with the runtime_context block?
//   3. Are there NO `[guard:placeholder]` markers in the final text?
//
// Step 0 exports the schema. Step 4 fills in the judge prompt.

import { z } from "zod";

export const ChatVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  hint: z.string().optional(),
  checks: z
    .object({
      ids_grounded: z.boolean(),
      runtime_values_consistent: z.boolean(),
      no_placeholder_markers: z.boolean(),
    })
    .partial()
    .default({}),
});

export type ChatVerdict = z.infer<typeof ChatVerdictSchema>;

export const chatRubric = {
  kind: "chat" as const,
  schema: ChatVerdictSchema,
  /** Step 4 fills this in. */
  prompt: "",
};
