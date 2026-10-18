import { z } from "@hono/zod-openapi";
import {
  AcceptDescriptionSchema,
  CatalogSourceSchema,
  CategorySchema,
  DescriptionSchema,
  descriptionAcceptanceValid,
  UNCATEGORIZED,
} from "../api/catalog-metadata.ts";

export const SkillScopeSchema = z.enum(["global", "connector", "workflow"]);

export function skillScopeViolation(input: {
  scope: z.infer<typeof SkillScopeSchema>;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
}): string | null {
  if (input.scope === "connector" && !input.connector_id)
    return "connector skill requires connector_id";
  if (input.scope === "workflow" && !input.workflow_id)
    return "workflow skill requires workflow_id";
  if (input.scope === "global" && (input.connector_id || input.workflow_id))
    return "global skill must not set connector_id or workflow_id";
  if (input.connector_id && input.workflow_id)
    return "skill cannot set both connector_id and workflow_id";
  return null;
}
export const SkillLifecycleSchema = z.enum(["draft", "active", "archived"]);
export const SkillSourceSchema = z.enum(["manual", "candidate", "template", "memory"]);

export const SkillSideEffectsSchema = z.enum(["none", "read", "write", "destructive"]);
export const SkillIdempotencySchema = z.enum(["none", "naturally", "key_required"]);
export const SkillMaturitySchema = z.enum(["experimental", "stable"]);
export const SkillAppliesToSchema = z.enum(["chat", "authoring", "both"]);

export const SkillActivationSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("baseline") }).openapi("SkillActivationBaseline"),

    z.object({ kind: z.literal("tool"), tool: z.string().min(1) }).openapi("SkillActivationTool"),

    z
      .object({
        kind: z.literal("tool_arg"),
        tool: z.string().min(1),
        path: z.string().min(1),
        equals: z.union([z.string(), z.boolean(), z.number()]),
      })
      .openapi("SkillActivationToolArg"),

    z
      .object({ kind: z.literal("connector_driver"), driver: z.string().min(1) })
      .openapi("SkillActivationConnectorDriver"),

    z
      .object({ kind: z.literal("connector_template"), slug: z.string().min(1) })
      .openapi("SkillActivationConnectorTemplate"),

    z
      .object({ kind: z.literal("connector_recipe_match"), template: z.string().min(1) })
      .openapi("SkillActivationConnectorRecipeMatch"),

    z
      .object({ kind: z.literal("intent_keyword"), word: z.string().min(1) })
      .openapi("SkillActivationIntentKeyword"),

    z
      .object({
        kind: z.literal("step_kind"),
        step_kinds: z
          .array(
            z.enum([
              "request",
              "transform",
              "call",
              "wait",
              "wait_for_event",
              "branch",
              "parallel",
              "loop",
              "tool",
            ]),
          )
          .min(1),
      })
      .openapi("SkillActivationStepKind"),

    z
      .object({
        kind: z.literal("diagnosis"),
        codes: z.array(z.string().min(1)).min(1),
      })
      .openapi("SkillActivationDiagnosis"),
  ])
  .openapi("SkillActivation");

const JsonSchemaRecord = z.record(z.string(), z.unknown());

export const SkillSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    scope: SkillScopeSchema,
    connector_id: z.string().uuid().nullable(),
    workflow_id: z.string().uuid().nullable(),
    slug: z.string().nullable().default(null),
    title: z.string().min(1),
    description: z.string().nullable().default(null),
    description_source: CatalogSourceSchema.default("llm"),
    category: z.string().default(UNCATEGORIZED),
    category_source: CatalogSourceSchema.default("llm"),
    body: z.string().min(1),
    examples: z.array(z.string()).default([]),
    best_practices: z.array(z.string()).default([]),
    pitfalls: z.array(z.string()).default([]),
    doc_refs: z.array(z.string()).default([]),
    gates_tools: z.array(z.string().min(1)).default([]),
    activates_when: z.array(SkillActivationSchema).default([]),
    input_schema: JsonSchemaRecord.nullable().default(null),
    output_schema: JsonSchemaRecord.nullable().default(null),
    side_effects: SkillSideEffectsSchema.default("read"),
    idempotency: SkillIdempotencySchema.default("none"),
    maturity: SkillMaturitySchema.default("stable"),
    tags: z.array(z.string().min(1)).default([]),
    applies_to: SkillAppliesToSchema.default("both"),
    status: SkillLifecycleSchema,
    source: SkillSourceSchema,
    version: z.number().int().min(1),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Skill");

export const CreateSkillSchema = z
  .object({
    scope: SkillScopeSchema,
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    title: z.string().min(1),
    description: DescriptionSchema.nullable().optional(),
    category: CategorySchema.nullable().optional(),
    body: z.string().min(1),
    examples: z.array(z.string()).optional(),
    best_practices: z.array(z.string()).optional(),
    pitfalls: z.array(z.string()).optional(),
    doc_refs: z.array(z.string()).optional(),
    gates_tools: z.array(z.string().min(1)).optional(),
    activates_when: z.array(SkillActivationSchema).optional(),
    input_schema: JsonSchemaRecord.nullable().optional(),
    output_schema: JsonSchemaRecord.nullable().optional(),
    side_effects: SkillSideEffectsSchema.optional(),
    idempotency: SkillIdempotencySchema.optional(),
    maturity: SkillMaturitySchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    applies_to: SkillAppliesToSchema.optional(),
    status: SkillLifecycleSchema.optional(),
    source: SkillSourceSchema.optional(),
  })
  .openapi("CreateSkillBody");

export const UpdateSkillSchema = z
  .object({
    expected_version: z.number().int().positive().optional(),
    title: z.string().min(1).optional(),
    description: DescriptionSchema.nullable().optional(),
    accept_description: AcceptDescriptionSchema.optional(),
    category: CategorySchema.nullable().optional(),
    body: z.string().min(1).optional(),
    examples: z.array(z.string()).optional(),
    best_practices: z.array(z.string()).optional(),
    pitfalls: z.array(z.string()).optional(),
    doc_refs: z.array(z.string()).optional(),
    gates_tools: z.array(z.string().min(1)).optional(),
    activates_when: z.array(SkillActivationSchema).optional(),
    input_schema: JsonSchemaRecord.nullable().optional(),
    output_schema: JsonSchemaRecord.nullable().optional(),
    side_effects: SkillSideEffectsSchema.optional(),
    idempotency: SkillIdempotencySchema.optional(),
    maturity: SkillMaturitySchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    applies_to: SkillAppliesToSchema.optional(),
    status: SkillLifecycleSchema.optional(),
  })
  .refine(descriptionAcceptanceValid, {
    message: "accept_description requires the exact nonempty description",
    path: ["accept_description"],
  })
  .openapi("UpdateSkillBody");

export type Skill = z.infer<typeof SkillSchema>;
export type SkillScope = z.infer<typeof SkillScopeSchema>;
export type SkillLifecycle = z.infer<typeof SkillLifecycleSchema>;
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type SkillSideEffects = z.infer<typeof SkillSideEffectsSchema>;
export type SkillIdempotency = z.infer<typeof SkillIdempotencySchema>;
export type SkillMaturity = z.infer<typeof SkillMaturitySchema>;
export type SkillActivation = z.infer<typeof SkillActivationSchema>;
export type SkillAppliesTo = z.infer<typeof SkillAppliesToSchema>;
export type SkillAudience = "chat" | "authoring";

export function skillAudienceForAuthoringMode(mode: string | null | undefined): SkillAudience {
  return mode === "workflow" ? "authoring" : "chat";
}

export function skillOfferedTo(applies_to: SkillAppliesTo, audience: SkillAudience): boolean {
  return applies_to === "both" || applies_to === audience;
}
export type CreateSkillInput = z.infer<typeof CreateSkillSchema>;
export type UpdateSkillInput = z.infer<typeof UpdateSkillSchema>;

export interface SkillExamplesBlob {
  examples?: string[];
  best_practices?: string[];
  pitfalls?: string[];
  doc_refs?: string[];
}
