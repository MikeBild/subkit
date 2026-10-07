import { z } from "@hono/zod-openapi";
import { CategorySchema } from "../api/catalog-metadata.ts";
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

export const RecipeOriginSchema = z
  .object({
    vertical: z.string().min(1).max(64),
    slug: z.string().min(1).max(128),
  })
  .strict()
  .describe("The recipe pack entry this workflow was created from; recorded in the audit trail.")
  .openapi("RecipeOrigin");
export type RecipeOrigin = z.infer<typeof RecipeOriginSchema>;

export function recipeAuditMetadata(origin: RecipeOrigin): Record<string, string> {
  return { source: "recipe", recipe_vertical: origin.vertical, recipe_slug: origin.slug };
}

const DraftBodySchema = z.object({
  definition: WorkflowDefSchema,
  category: CategorySchema.optional(),
});

export const CreateWorkflowDraftSchema = DraftBodySchema.extend({
  recipe: RecipeOriginSchema.optional(),
})
  .strict()
  .openapi("CreateWorkflowDraft");

export const UpdateWorkflowDraftSchema = DraftBodySchema.extend({
  expected_draft_version_id: z.string().uuid().nullable(),
})
  .strict()
  .openapi("UpdateWorkflowDraft");
