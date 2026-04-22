// Skill record shape — mirrors docs/04-authoring.md. Skills are authored by
// operators via REST, CLI, or chat; the engine loads them into prompts in
// scope order but never creates, mutates, or promotes them automatically.

import { z } from "@hono/zod-openapi";

export const SkillScopeSchema = z.enum(["global", "connector", "workflow"]);
export const SkillLifecycleSchema = z.enum(["draft", "active", "archived"]);
export const SkillSourceSchema = z.enum(["manual", "candidate", "template", "memory"]);

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
    status: SkillLifecycleSchema.optional(),
    source: SkillSourceSchema.optional(),
  })
  .openapi("CreateSkillBody");

export const UpdateSkillSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    examples: z.array(z.string()).optional(),
    best_practices: z.array(z.string()).optional(),
    pitfalls: z.array(z.string()).optional(),
    doc_refs: z.array(z.string()).optional(),
    status: SkillLifecycleSchema.optional(),
  })
  .openapi("UpdateSkillBody");

export type Skill = z.infer<typeof SkillSchema>;
export type SkillScope = z.infer<typeof SkillScopeSchema>;
export type SkillLifecycle = z.infer<typeof SkillLifecycleSchema>;
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type CreateSkillInput = z.infer<typeof CreateSkillSchema>;
export type UpdateSkillInput = z.infer<typeof UpdateSkillSchema>;

/** Shape persisted in the `examples` jsonb column. */
export interface SkillExamplesBlob {
  examples?: string[];
  best_practices?: string[];
  pitfalls?: string[];
  doc_refs?: string[];
}
