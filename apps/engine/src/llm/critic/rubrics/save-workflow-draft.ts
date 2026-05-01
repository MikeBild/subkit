// save-workflow-draft critic rubric.
//
// Triggered when the loop terminates on `save_workflow_draft` (workflow
// commit) or `save_connector_draft` (connector save). The artifact
// carries STRUCTURAL FACTS about what was committed (not just
// prose) so the rubric's checks are grounded:
//
//   1. saved                    — artifact_id is non-null
//   2. auth_or_trigger_defined  — connector has an auth_mode set, OR
//                                 workflow has at least one step + a
//                                 trigger_kind that isn't 'unknown'
//   3. validated_step_present   — validated_step_count >= 1
//   4. no_placeholder_markers   — committed_text has no [guard:…]
//   5. credentials_exist        — every referenced_credential id
//                                 appears in the snapshot
//
// All five are deterministic predicates over the artifact fields —
// no second LLM call.

import { z } from "zod";

export const SaveWorkflowDraftArtifactSchema = z.object({
  resource_kind: z.enum(["connector", "workflow"]),
  resource_id: z.string().nullable(),
  /** Connectors only: the auth mode actually configured on the saved row. */
  connector_auth_mode: z.string().nullable().default(null),
  /** Workflows only: the trigger kind actually configured. */
  workflow_trigger_kind: z.string().nullable().default(null),
  /** Number of steps that successfully passed validation in this draft. */
  validated_step_count: z.number().int().nonnegative().default(0),
  /** The actual committed assistant prose — scanned for placeholder leakage. */
  committed_text: z.string(),
  /** Credential ids the artifact depends on — checked against the snapshot. */
  referenced_credentials: z.array(z.string()).default([]),
});

export type SaveWorkflowDraftArtifact = z.infer<typeof SaveWorkflowDraftArtifactSchema>;

export const SaveWorkflowDraftVerdictSchema = z.object({
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

export type SaveWorkflowDraftVerdict = z.infer<typeof SaveWorkflowDraftVerdictSchema>;

export const saveWorkflowDraftRubric = {
  kind: "save_workflow_draft" as const,
  schema: SaveWorkflowDraftVerdictSchema,
};
