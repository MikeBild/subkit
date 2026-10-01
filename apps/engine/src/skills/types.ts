// Skill record shape — mirrors docs/authors/authoring-workflows.md. Skills are authored by
// operators via REST, CLI, or chat; the engine loads them into prompts in
// scope order but never creates, mutates, or promotes them automatically.

import { z } from "@hono/zod-openapi";

export const SkillScopeSchema = z.enum(["global", "connector", "workflow"]);
export const SkillLifecycleSchema = z.enum(["draft", "active", "archived"]);
export const SkillSourceSchema = z.enum(["manual", "candidate", "template", "memory"]);

// Capability/safety vocabulary. These are first-class metadata fields that
// gate how the engine treats a skill in the conversation loop:
//   - side_effects=destructive triggers a banner in assembled context and
//     forces an explicit `confirmed:true` on commit-style tools.
//   - idempotency=naturally lets the engine retry without an Idempotency-Key.
//   - maturity=experimental is excluded from baseline auto-load — only
//     reachable via explicit `load_skill(slug)`.
export const SkillSideEffectsSchema = z.enum(["none", "read", "write", "destructive"]);
export const SkillIdempotencySchema = z.enum(["none", "naturally", "key_required"]);
export const SkillMaturitySchema = z.enum(["experimental", "stable"]);

// Activation rules. A single discriminated union replaces the legacy
// front-matter trio (`gates_tools`, `auto_load`, `trigger_keywords`) plus
// the hand-maintained `RULES` table that used to live in
// `apps/engine/src/conversations/skill-autoload.ts`. The matcher in
// skill-autoload is now data-driven: it reads each skill's `activates_when`
// and decides per-turn whether to auto-load.
export const SkillActivationSchema = z
  .discriminatedUnion("kind", [
    // Always-on. Subsumes the old `auto_load: true`.
    z.object({ kind: z.literal("baseline") }).openapi("SkillActivationBaseline"),

    // Tool name match (subsumes a single `gates_tools` entry).
    z.object({ kind: z.literal("tool"), tool: z.string().min(1) }).openapi("SkillActivationTool"),

    // Tool name + argument-path predicate. `path` is dot-notation against the
    // tool input ("step.config.driver"); `equals` is a primitive scalar.
    z
      .object({
        kind: z.literal("tool_arg"),
        tool: z.string().min(1),
        path: z.string().min(1),
        equals: z.union([z.string(), z.boolean(), z.number()]),
      })
      .openapi("SkillActivationToolArg"),

    // Driver of any connector currently in scope.
    z
      .object({ kind: z.literal("connector_driver"), driver: z.string().min(1) })
      .openapi("SkillActivationConnectorDriver"),

    // Connector created from a specific template slug.
    z
      .object({ kind: z.literal("connector_template"), slug: z.string().min(1) })
      .openapi("SkillActivationConnectorTemplate"),

    // Recipe lookup against a connector template — automatically loaded
    // when `build_workflow` runs against a connector whose template ships
    // recipes that derive from this skill.
    z
      .object({ kind: z.literal("connector_recipe_match"), template: z.string().min(1) })
      .openapi("SkillActivationConnectorRecipeMatch"),

    // Word in the user turn (subsumes a single `trigger_keywords` entry).
    z
      .object({ kind: z.literal("intent_keyword"), word: z.string().min(1) })
      .openapi("SkillActivationIntentKeyword"),

    // Workflow step kind appears in the tool-call input (the LLM is
    // currently authoring a workflow that uses the named primitive).
    // Skills that document a specific step kind (e.g. `wait_for_event`,
    // `state_read`/`state_write`, `fan_out`) auto-load when the LLM
    // touches that primitive — the documenting prose lands in context
    // exactly when it's needed, not on every turn.
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

    // A tool RESULT names one of these diagnosis codes — a
    // `repair_guidance[].code` or `.reason` from a readiness or gate
    // diagnosis. Exact match, like every other rule: the skill that explains
    // a refusal lands in context the moment the refusal is reported.
    z
      .object({
        kind: z.literal("diagnosis"),
        codes: z.array(z.string().min(1)).min(1),
      })
      .openapi("SkillActivationDiagnosis"),
  ])
  .openapi("SkillActivation");

// JSONSchema-shaped record. Permissive on purpose — JSONSchema itself is
// open-shaped and we want operator-supplied schemas to round-trip cleanly.
const JsonSchemaRecord = z.record(z.string(), z.unknown());

/**
 * Authoring shape (what operators see). The persisted row collapses
 * `examples`, `best_practices`, `pitfalls`, and `doc_refs` into a single
 * `examples` jsonb blob — see `toRow` / `toView` in the service.
 */
export const SkillSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    scope: SkillScopeSchema,
    connector_id: z.string().uuid().nullable(),
    workflow_id: z.string().uuid().nullable(),
    /** Cross-tenant stable identifier used by `load_skill(slug)` and the
     *  seed loader. Null for manually-authored skills that never passed
     *  through the seed path. */
    slug: z.string().nullable().default(null),
    title: z.string().min(1),
    body: z.string().min(1),
    examples: z.array(z.string()).default([]),
    best_practices: z.array(z.string()).default([]),
    pitfalls: z.array(z.string()).default([]),
    doc_refs: z.array(z.string()).default([]),
    /** Tool names that are invisible to the LLM until this skill is
     *  loaded. Complements `activates_when`: `activates_when` decides
     *  WHEN this skill auto-loads; `gates_tools` decides which tools
     *  are unavailable until it is loaded. Read by
     *  `conversations/tools/gated.ts`. */
    gates_tools: z.array(z.string().min(1)).default([]),
    /** Data-driven activation rules. Empty array means "never auto-loads;
     *  only reachable via explicit `load_skill(slug)`." */
    activates_when: z.array(SkillActivationSchema).default([]),
    /** Optional JSONSchema describing the workflow input the skill expects.
     *  When a workflow declares `derived_from_skill_id` pointing at this
     *  skill, the workflow validator requires the workflow's input_schema
     *  to be a structural superset. */
    input_schema: JsonSchemaRecord.nullable().default(null),
    /** Optional JSONSchema describing the workflow output the skill
     *  promises. Same proof-before-save invariant as input_schema. */
    output_schema: JsonSchemaRecord.nullable().default(null),
    side_effects: SkillSideEffectsSchema.default("read"),
    idempotency: SkillIdempotencySchema.default("none"),
    maturity: SkillMaturitySchema.default("stable"),
    tags: z.array(z.string().min(1)).default([]),
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
    status: SkillLifecycleSchema.optional(),
    source: SkillSourceSchema.optional(),
  })
  .openapi("CreateSkillBody");

export const UpdateSkillSchema = z
  .object({
    expected_version: z.number().int().positive().optional(),
    title: z.string().min(1).optional(),
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
    status: SkillLifecycleSchema.optional(),
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
export type CreateSkillInput = z.infer<typeof CreateSkillSchema>;
export type UpdateSkillInput = z.infer<typeof UpdateSkillSchema>;

/** Shape persisted in the `examples` jsonb column. */
export interface SkillExamplesBlob {
  examples?: string[];
  best_practices?: string[];
  pitfalls?: string[];
  doc_refs?: string[];
}
