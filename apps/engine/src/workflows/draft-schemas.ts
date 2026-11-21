import { z } from "@hono/zod-openapi";
import { CategorySchema } from "../api/catalog-metadata.ts";
import { WorkflowDefSchema, WorkflowDraftDefSchema } from "./types.ts";

const SpecText = z.string().trim().min(1).max(2000);
const SpecName = z.string().trim().min(1).max(200);

const WorkflowSpecFieldSchema = z
  .object({
    name: SpecName,
    description: SpecText.optional(),
  })
  .strict()
  .openapi("WorkflowSpecField");

const WorkflowSpecDeliverySchema = z
  .object({
    channel: SpecName.describe("Where the result goes, for example email, slack or a file."),
    destination: SpecText.optional().describe("The concrete recipient, address or location."),
    description: SpecText.optional(),
  })
  .strict()
  .openapi("WorkflowSpecDelivery");

const WorkflowSpecConventionSchema = z
  .object({
    skill_id: z.string().uuid().optional().describe("The skill the convention comes from."),
    note: SpecText.describe("The convention as applied to this workflow."),
  })
  .strict()
  .openapi("WorkflowSpecConvention");

const WorkflowSpecEvidenceSchema = z
  .object({
    source: SpecName.describe(
      "Where the evidence comes from, for example a connector or document.",
    ),
    locator: SpecText.describe("The exact place inside the source."),
  })
  .strict()
  .openapi("WorkflowSpecEvidence");

const WorkflowSpecOriginSchema = z
  .enum(["person", "chat", "derived"])
  .describe(
    "Who stated the spec: a person, the authoring chat, or derived from existing material. Only a person's statement counts as confirmed.",
  )
  .openapi("WorkflowSpecOrigin");

export const WorkflowSpecSchema = z
  .object({
    goal: SpecText.nullable().describe("What the workflow is for; null while unknown."),
    inputs: z.array(WorkflowSpecFieldSchema).max(50),
    outputs: z.array(WorkflowSpecFieldSchema).max(50),
    delivery: WorkflowSpecDeliverySchema.nullable(),
    conventions_applied: z.array(WorkflowSpecConventionSchema).max(50),
    evidence: z.array(WorkflowSpecEvidenceSchema).max(50),
    open_questions: z.array(SpecText).max(50),
    origin: WorkflowSpecOriginSchema,
  })
  .strict()
  .describe(
    "Purpose and acceptance of a workflow version. Versioned with the workflow and never part of its executed definition.",
  )
  .openapi("WorkflowSpec");
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

export const WorkflowDraftSchema = z
  .object({
    workflow_id: z.string().uuid(),
    version_id: z.string().uuid(),
    version: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    current_version_id: z.string().uuid().nullable(),
    definition: WorkflowDraftDefSchema,
    spec: z.union([WorkflowSpecSchema, z.null()]),
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
  spec: WorkflowSpecSchema.optional().describe(
    "The spec stored with the new draft version; omit to keep the spec of the version this draft is based on.",
  ),
});

export const CreateWorkflowDraftSchema = DraftBodySchema.extend({
  recipe: RecipeOriginSchema.optional(),
})
  .strict()
  .openapi("CreateWorkflowDraft");

export const UpdateWorkflowDraftSchema = DraftBodySchema.extend({
  expected_draft_version_id: z.string().uuid().nullable(),
  expected_current_version_id: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe(
      "The active version id this draft was based on, or null when the workflow had none. The save is refused with 409 and reason version_conflict when another version became active meanwhile; omit to skip this check.",
    ),
})
  .strict()
  .openapi("UpdateWorkflowDraft");
