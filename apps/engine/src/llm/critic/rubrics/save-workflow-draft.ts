import { z } from "zod";

export const SaveWorkflowDraftArtifactSchema = z.object({
  resource_kind: z.enum(["connector", "workflow"]),
  resource_id: z.string().nullable(),
  connector_auth_mode: z.string().nullable().default(null),
  workflow_trigger_kind: z.string().nullable().default(null),
  validated_step_count: z.number().int().nonnegative().default(0),
  committed_text: z.string(),
  referenced_credentials: z.array(z.string()).default([]),
});

export type SaveWorkflowDraftArtifact = z.infer<typeof SaveWorkflowDraftArtifactSchema>;

export const SaveWorkflowDraftVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  hint: z.string().optional(),
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
