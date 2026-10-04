import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { getBuiltinTemplate } from "../../connectors/templates.ts";
import { conversations } from "../../db/schema/index.ts";
import { withWorkflowDraft } from "../authoring-state.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { buildDraftMutationPayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    template_slug: z
      .string()
      .min(1)
      .describe("Connector template slug (e.g. `stripe`, `github`, `postgres`)."),
    recipe_slug: z
      .string()
      .min(1)
      .describe(
        "Recipe slug from the template (e.g. `list-customers`). Use `match_connector_template_by_url` or list the template to discover available recipes.",
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("Optional override for the cloned workflow's name. Defaults to the recipe title."),
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .describe(
        "Optional stable slug. Defaults to `<template_slug>-<recipe_slug>` so distinct clones do not collide.",
      ),
    connector_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Single-connector path. Bind every request step that carries the placeholder connector_id `00000000-0000-0000-0000-000000000000` to this saved connector id. Required for SQL/Postgres-style recipes that cannot express the connector via a base_url placeholder. Reject when the recipe declares `required_connectors` — use `connector_bindings` instead.",
      ),
    connector_bindings: z
      .record(z.string().uuid(), z.string().uuid())
      .optional()
      .describe(
        "Multi-connector path. Map each placeholder UUID declared in `recipe.required_connectors` to a saved connector id. Required when `required_connectors` is non-empty; the tool rejects partial maps with the missing placeholders listed.",
      ),
  })
  .openapi("StartWorkflowFromRecipeToolInput");

const PLACEHOLDER_CONNECTOR_ID = "00000000-0000-0000-0000-000000000000";

function rebindConnectorIds(workflow: unknown, bindings: Record<string, string>): unknown {
  if (Array.isArray(workflow)) {
    return workflow.map((v) => rebindConnectorIds(v, bindings));
  }
  if (workflow === null || typeof workflow !== "object") return workflow;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(workflow as Record<string, unknown>)) {
    if (k === "connector_id" && typeof v === "string" && v in bindings) {
      out[k] = bindings[v];
    } else {
      out[k] = rebindConnectorIds(v, bindings);
    }
  }
  return out;
}

export const startWorkflowFromRecipeTool: ConversationTool = {
  name: "start_workflow_from_recipe",
  description:
    "Clone a per-template executable recipe into a workflow draft. Use this before authoring from scratch — recipes carry guaranteed-valid step shapes (auth, paths, pagination) so the saved workflow does not need edit_workflow_patch rework loops.",
  use_case:
    'Operator says "list my last 10 Stripe customers" → call `start_workflow_from_recipe(template_slug="stripe", recipe_slug="list-customers")` and edit the draft instead of authoring from prose + OpenAPI.',
  important_notes: [
    "The cloned draft validates as-is under WorkflowDefSchema. Only override fields the user explicitly customized.",
    "Recipes are READ ONLY in templates.json. Edits land on the draft, not on the template.",
    "If the recipe declares `derived_from_skill`, the cloned workflow's `derived_from_skill_id` is populated so `save_workflow_draft` can apply the skill-schema gate.",
    "Multi-connector recipes (non-empty `required_connectors`) require `connector_bindings` covering every declared placeholder UUID. The single `connector_id` arg is rejected for those — use `inspect_recipe` to see the placeholder roster, then resolve each placeholder to a saved connector via `find_connector` before cloning.",
  ],
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const template = getBuiltinTemplate(args.template_slug);
    if (!template) {
      return {
        ok: false,
        error_code: "connector_template_unknown",
        message: `no built-in template with slug \`${args.template_slug}\``,
        next_best_actions: ["match_connector_template_by_url", "suggest_connector_templates"],
      };
    }
    const recipe = template.recipes.find((r) => r.slug === args.recipe_slug);
    if (!recipe) {
      const available = template.recipes.map((r) => r.slug);
      return {
        ok: false,
        error_code: "connector_recipe_unknown",
        message:
          available.length === 0
            ? `template \`${args.template_slug}\` ships no recipes — author from scratch with author_workflow.`
            : `no recipe \`${args.recipe_slug}\` on template \`${args.template_slug}\`. Available: ${available.join(", ")}.`,
        next_best_actions:
          available.length > 0 ? ["start_workflow_from_recipe"] : ["author_workflow"],
        data: { available_recipes: available },
      };
    }

    const required = recipe.required_connectors ?? [];
    let bindings: Record<string, string> = {};
    if (required.length > 0) {
      if (args.connector_id !== undefined) {
        return {
          ok: false,
          error_code: "connector_bindings_required",
          message: `recipe \`${args.recipe_slug}\` declares ${required.length} required connector placeholder(s); pass them via \`connector_bindings\` instead of the single-connector \`connector_id\` arg.`,
          next_best_actions: ["inspect_recipe", "find_connector", "start_workflow_from_recipe"],
          data: { required_connectors: required },
        };
      }
      const supplied = args.connector_bindings ?? {};
      const missing = required.filter((r) => !(r.placeholder in supplied));
      if (missing.length > 0) {
        return {
          ok: false,
          error_code: "connector_bindings_missing",
          message: `recipe \`${args.recipe_slug}\` requires bindings for ${missing.length} of ${required.length} placeholder(s): ${missing.map((m) => `\`${m.placeholder}\` (template: ${m.template})`).join(", ")}.`,
          next_best_actions: ["inspect_recipe", "find_connector", "start_workflow_from_recipe"],
          data: { required_connectors: required, missing_placeholders: missing },
        };
      }
      bindings = { ...supplied };
    } else if (args.connector_bindings) {
      bindings = { ...args.connector_bindings };
    }
    if (args.connector_id !== undefined) {
      bindings[PLACEHOLDER_CONNECTOR_ID] = args.connector_id;
    }

    const slug = args.slug ?? `${args.template_slug}-${args.recipe_slug}`;
    const name = args.name ?? recipe.title;
    const goal = [
      args.name && args.name !== recipe.title ? args.name : null,
      recipe.title,
      recipe.description,
    ]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .filter((part, index, all) => all.indexOf(part) === index)
      .join(" — ");
    const clonedRaw = JSON.parse(JSON.stringify(recipe.workflow));
    const cloned = (
      Object.keys(bindings).length > 0 ? rebindConnectorIds(clonedRaw, bindings) : clonedRaw
    ) as WorkflowDraftDocument;
    const nextWorkflow: WorkflowDraftDocument = {
      ...cloned,
      name,
      slug,
      description: cloned.description ?? recipe.description,
      ...(goal.length > 0 ? { goal } : {}),
      ...(recipe.derived_from_skill ? { derived_from_skill_id: recipe.derived_from_skill } : {}),
    };
    const draft = ctx.getDraft();
    const nextDraft = withWorkflowDraft(draft, nextWorkflow, "workflow_seeded_from_recipe");
    await ctx.setDraft(nextDraft);
    await ctx.db
      .update(conversations)
      .set({ target_workflow_id: null, updated_at: new Date() })
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      );
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          name,
          slug,
          template_slug: args.template_slug,
          recipe_slug: args.recipe_slug,
          step_count: nextWorkflow.steps?.length ?? 0,
          derived_from_skill: recipe.derived_from_skill,
          required_connectors: required,
          connector_bindings_applied: Object.keys(bindings).length,
          next_hint:
            "Recipe cloned. Inspect with inspect_workflow_draft, dry_run with dry_run_workflow, then save_workflow_draft.",
        },
      }),
    };
  },
};
