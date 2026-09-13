// inspect_recipe — read-only fetcher for the heavier per-recipe fields
// (description, sample_input, expected_output_preview, prerequisites,
// workflow shape summary) that `formatConnectorRecipes` deliberately
// keeps out of every-turn context to stay within the token budget.
//
// Workflow:
//   1. The per-turn context surfaces the recipe roster as
//      `slug + title + category + tags + difficulty + intent_keywords`.
//   2. The LLM narrows to 1-3 candidates from that roster.
//   3. The LLM calls `inspect_recipe(template_slug, recipe_slug)` to
//      see whether each candidate matches the operator intent before
//      paying for `start_workflow_from_recipe`'s clone.
//
// The tool is read-only — no draft mutation, no audit beyond the
// standard tool-call log. It does not return the full workflow body
// (only step kinds + step ids) because the body is large and the
// downstream `start_workflow_from_recipe` tool already gives the LLM
// the editable draft. If the operator confirms the candidate, the LLM
// then calls `start_workflow_from_recipe`.

import { z } from "@hono/zod-openapi";

import { resolveConnectorTemplate } from "../../connectors/template-resolver.ts";
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
      .describe("Recipe slug from the template (e.g. `list-customers`)."),
  })
  .openapi("InspectRecipeToolInput");

interface StepSummary {
  id: string;
  kind: string;
  notes?: string;
}

function summarizeStep(step: Record<string, unknown>): StepSummary {
  const id = typeof step.id === "string" ? step.id : "<unknown>";
  const kind = typeof step.kind === "string" ? step.kind : "<unknown>";
  const notes: string[] = [];
  if (typeof step.method === "string" && typeof step.url === "string") {
    notes.push(`${step.method} ${step.url}`);
  }
  if (typeof (step as { sql?: unknown }).sql === "object" && step.sql !== null) {
    notes.push("sql block");
  }
  if (typeof (step as { graphql?: unknown }).graphql === "object" && step.graphql !== null) {
    notes.push("graphql query");
  }
  if (typeof step.expression === "string") {
    notes.push("jsonata transform");
  }
  if ((step as { pagination?: unknown }).pagination) {
    notes.push("paginated");
  }
  return notes.length > 0 ? { id, kind, notes: notes.join("; ") } : { id, kind };
}

export const inspectRecipeTool: ConversationTool = {
  name: "inspect_recipe",
  description:
    "Inspect a recipe in depth before cloning. Returns description, prerequisites, sample_input, expected_output_preview, and a per-step shape summary. Use when the per-turn recipe roster lists 2+ candidates and you need to pick one.",
  use_case:
    'Operator says "show me my recent Stripe customers" → roster lists `list-customers` and `list-charges` → call `inspect_recipe(template_slug="stripe", recipe_slug="list-customers")` → confirm match → then `start_workflow_from_recipe(...)`.',
  important_notes: [
    "Read-only. No draft mutation, no clone. Use `start_workflow_from_recipe` to actually clone.",
    "Returns step shapes (kind + method/url) but never the full workflow body — the cloned draft is the editable surface.",
    "If `deprecated` is set, the recipe still exists but `start_workflow_from_recipe` will warn and recommend `replacement_slug`.",
  ],
  inputSchema,
  category: "tenant_read" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    // Consult the tenant-aware resolver so tenant-scoped template
    // overrides (rows in connector_templates) win over built-ins —
    // matches the deleted mcp/tools/recipes.ts behavior. Built-ins
    // alone would skip operators who've shadowed a built-in template
    // with a tenant-customized version.
    const resolved = await resolveConnectorTemplate({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      slug: args.template_slug,
    });
    if (!resolved) {
      return {
        ok: false,
        error_code: "connector_template_unknown",
        message: `no template with slug \`${args.template_slug}\``,
        next_best_actions: ["match_connector_template_by_url", "suggest_connector_templates"],
      };
    }
    const template = resolved.template;
    const recipe = template.recipes.find((r) => r.slug === args.recipe_slug);
    if (!recipe) {
      const available = template.recipes.map((r) => r.slug);
      return {
        ok: false,
        error_code: "connector_recipe_unknown",
        message:
          available.length === 0
            ? `template \`${args.template_slug}\` ships no recipes`
            : `no recipe \`${args.recipe_slug}\` on template \`${args.template_slug}\`. Available: ${available.join(", ")}.`,
        next_best_actions:
          available.length > 0 ? ["inspect_recipe", "start_workflow_from_recipe"] : [],
        data: { available_recipes: available },
      };
    }
    const wf = recipe.workflow as { steps?: Array<Record<string, unknown>> };
    const steps = (wf.steps ?? []).map(summarizeStep);
    return {
      ok: true,
      data: {
        template_slug: args.template_slug,
        recipe_slug: args.recipe_slug,
        title: recipe.title,
        description: recipe.description,
        category: recipe.category,
        tags: recipe.tags,
        difficulty: recipe.difficulty,
        estimated_setup_minutes: recipe.estimated_setup_minutes,
        prerequisites: recipe.prerequisites,
        intent_keywords: recipe.intent_keywords,
        sample_input: recipe.sample_input,
        expected_output_preview: recipe.expected_output_preview,
        required_connectors: recipe.required_connectors,
        version: recipe.version,
        author: recipe.author,
        last_validated_at: recipe.last_validated_at,
        deprecated: recipe.deprecated,
        derived_from_skill: recipe.derived_from_skill,
        step_count: steps.length,
        step_summary: steps,
        next_hint:
          recipe.deprecated != null
            ? `This recipe is deprecated. Consider \`${recipe.deprecated.replacement_slug}\` instead. Cloning still works.`
            : "Confirm the recipe matches the operator intent, then call `start_workflow_from_recipe` to clone.",
      },
    };
  },
};
