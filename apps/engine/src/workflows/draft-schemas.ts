import { z } from "@hono/zod-openapi";
import { WorkflowDefSchema } from "./types.ts";

export const WorkflowDraftSchema = z
  .object({
    workflow_id: z.string().uuid(),
    version_id: z.string().uuid(),
    version: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    current_version_id: z.string().uuid().nullable(),
    definition: WorkflowDefSchema,
  })
  .openapi("WorkflowDraft");

export const CreateWorkflowDraftSchema = z
  .object({
    definition: WorkflowDefSchema,
  })
  .strict()
  .openapi("CreateWorkflowDraft");

export const UpdateWorkflowDraftSchema = CreateWorkflowDraftSchema.extend({
  expected_draft_version_id: z.string().uuid().nullable(),
}).openapi("UpdateWorkflowDraft");
