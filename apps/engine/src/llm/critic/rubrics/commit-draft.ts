// commit-draft critic rubric.
//
// Triggered when the loop terminates on `commit_draft` (workflow
// commit) or `save_connector_draft` (connector save). Asks the
// tenant-default model to verdict-check a freshly committed artifact
// against five concrete questions:
//
//   1. Was the artifact actually saved (id present)?
//   2. Is the auth flow defined (connector) or trigger defined (workflow)?
//   3. Is at least one validated step present?
//   4. Are there NO `[guard:placeholder]` markers in the committed text?
//   5. Do all referenced credentials exist in the tenant snapshot?
//
// Step 0 exports the schema + the (empty) judge prompt. Step 4
// fills in the prompt body.

import { z } from "zod";

export const CommitDraftArtifactSchema = z.object({
  resource_kind: z.enum(["connector", "workflow"]),
  resource_id: z.string().nullable(),
  /** Canonicalised text or JSON of what was committed — used for grounded scanning. */
  committed_text: z.string(),
  /** Connector id <→ credential id references the artifact depends on. */
  referenced_credentials: z.array(z.string()).default([]),
});

export type CommitDraftArtifact = z.infer<typeof CommitDraftArtifactSchema>;

export const CommitDraftVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  hint: z.string().optional(),
  /** Per-question outcomes — surfaces in audit + telemetry. */
  checks: z
    .object({
      saved: z.boolean(),
      auth_or_trigger_defined: z.boolean(),
      validated_step_present: z.boolean(),
      no_placeholder_markers: z.boolean(),
      credentials_exist: z.boolean(),
    })
    .partial()
    .default({}),
});

export type CommitDraftVerdict = z.infer<typeof CommitDraftVerdictSchema>;

export const commitDraftRubric = {
  kind: "commit_draft" as const,
  schema: CommitDraftVerdictSchema,
  /** Step 4 fills this in. */
  prompt: "",
};
