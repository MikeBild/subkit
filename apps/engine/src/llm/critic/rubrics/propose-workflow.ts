// propose-workflow critic rubric.
//
// Triggered when the loop terminates on `propose_step` /
// `build_workflow` and the resulting workflow draft is about to be
// surfaced to the user. Asks the tenant-default model to verdict-check
// the proposal against:
//
//   1. Workflow name set (not the empty "new-workflow" placeholder)?
//   2. Trigger / first step defined?
//   3. At least one step present?
//   4. Each step shape Zod-validates against the workflow schema?
//
// Step 0 exports the artifact + verdict schemas. Step 4 fills in the
// judge prompt and wires schema validation against the canonical
// workflow Zod schema.

import { z } from "zod";

export const ProposeWorkflowArtifactSchema = z.object({
  workflow_name: z.string().nullable(),
  trigger_kind: z.string().nullable(),
  /** Step shapes as captured by the loop — opaque here; rubric validates them. */
  steps: z.array(z.record(z.string(), z.unknown())).default([]),
  /** Canonical text rendering for placeholder + ungrounded-claim scans. */
  proposal_text: z.string(),
});

export type ProposeWorkflowArtifact = z.infer<typeof ProposeWorkflowArtifactSchema>;

export const ProposeWorkflowVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  hint: z.string().optional(),
  checks: z
    .object({
      name_set: z.boolean(),
      trigger_defined: z.boolean(),
      has_steps: z.boolean(),
      steps_validate: z.boolean(),
    })
    .partial()
    .default({}),
});

export type ProposeWorkflowVerdict = z.infer<typeof ProposeWorkflowVerdictSchema>;

export const proposeWorkflowRubric = {
  kind: "propose_workflow" as const,
  schema: ProposeWorkflowVerdictSchema,
  /** Step 4 fills this in. */
  prompt: "",
};
