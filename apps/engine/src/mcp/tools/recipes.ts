// MCP `list_recipes` and `inspect_recipe` product tools.
//
// Mirror the conversation-tool surface (start_workflow_from_recipe +
// inspect_recipe) so external agents can browse the recipe catalog
// without starting a conversation. Stateless beyond a tenant-scope
// template lookup — recipes are global catalog data, but the resolver
// runs through the same template-source resolution path as the
// existing connector-template MCP tool so tenant overrides are honored.
//
// Both tools are read-only; no audit beyond the standard MCP tool-call
// log.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { resolveConnectorTemplate } from "../../connectors/template-resolver.ts";
import type { ConnectorRecipe } from "../../connectors/templates.ts";
import type { Db } from "../../db/client.ts";

export const LIST_RECIPES_TOOL_NAME = "list_recipes";
export const INSPECT_RECIPE_TOOL_NAME = "inspect_recipe";

export const listRecipesMcpTool: Tool = {
  name: LIST_RECIPES_TOOL_NAME,
  description:
    "List recipes shipped with a connector template. Each entry carries slug, title, category, tags, difficulty, and intent_keywords — enough to rank candidates without paying for the full workflow body. Use `inspect_recipe` to fetch description / sample_input / step shape before cloning via `start_workflow_from_recipe`.",
  inputSchema: {
    type: "object",
    properties: {
      template_slug: {
        type: "string",
        description: "Connector template slug (e.g. `stripe`, `github`, `postgres`).",
      },
    },
    required: ["template_slug"],
    additionalProperties: false,
  },
};

export interface ListRecipesArgs {
  template_slug: string;
}

export interface ListRecipesEntry {
  slug: string;
  title: string;
  category: string;
  tags: string[];
  difficulty: string;
  intent_keywords: string[];
  derived_from_skill: string | null;
  version: string;
  deprecated: { since: string; replacement_slug: string } | null;
}

export interface ListRecipesResult {
  template_slug: string;
  template_name: string;
  recipes: ListRecipesEntry[];
}

function summarize(r: ConnectorRecipe): ListRecipesEntry {
  return {
    slug: r.slug,
    title: r.title,
    category: r.category,
    tags: r.tags,
    difficulty: r.difficulty,
    intent_keywords: r.intent_keywords,
    derived_from_skill: r.derived_from_skill,
    version: r.version,
    deprecated: r.deprecated,
  };
}

export async function handleListRecipes(
  ctx: { db: Db; principal: ResolvedPrincipal },
  args: ListRecipesArgs,
): Promise<{ ok: true; data: ListRecipesResult } | { ok: false; data: { error: string } }> {
  const slug = args.template_slug ?? "";
  if (!slug) return { ok: false, data: { error: "template_slug is required" } };
  const resolved = await resolveConnectorTemplate({
    db: ctx.db,
    tenant_id: ctx.principal.tenant_id,
    slug,
  });
  if (!resolved) {
    return { ok: false, data: { error: `unknown connector template \`${slug}\`` } };
  }
  return {
    ok: true,
    data: {
      template_slug: resolved.template.slug,
      template_name: resolved.template.name,
      recipes: resolved.template.recipes.map(summarize),
    },
  };
}

export const inspectRecipeMcpTool: Tool = {
  name: INSPECT_RECIPE_TOOL_NAME,
  description:
    "Inspect a recipe in depth before cloning. Returns description, prerequisites, sample_input, expected_output_preview, and per-step kind/method summary. Read-only — to actually clone, call the conversation tool `start_workflow_from_recipe`.",
  inputSchema: {
    type: "object",
    properties: {
      template_slug: { type: "string", description: "Connector template slug." },
      recipe_slug: { type: "string", description: "Recipe slug from the template." },
    },
    required: ["template_slug", "recipe_slug"],
    additionalProperties: false,
  },
};

export interface InspectRecipeArgs {
  template_slug: string;
  recipe_slug: string;
}

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
  if (typeof step.expression === "string") notes.push("jsonata transform");
  if ((step as { pagination?: unknown }).pagination) notes.push("paginated");
  return notes.length > 0 ? { id, kind, notes: notes.join("; ") } : { id, kind };
}

export interface InspectRecipeResult {
  template_slug: string;
  recipe_slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  difficulty: string;
  estimated_setup_minutes: number;
  prerequisites: string[];
  intent_keywords: string[];
  sample_input: unknown;
  expected_output_preview: unknown;
  required_connectors: ConnectorRecipe["required_connectors"];
  version: string;
  author: string;
  last_validated_at: string | null;
  deprecated: { since: string; replacement_slug: string } | null;
  derived_from_skill: string | null;
  step_count: number;
  step_summary: StepSummary[];
}

export async function handleInspectRecipe(
  ctx: { db: Db; principal: ResolvedPrincipal },
  args: InspectRecipeArgs,
): Promise<{ ok: true; data: InspectRecipeResult } | { ok: false; data: { error: string } }> {
  const template_slug = args.template_slug ?? "";
  const recipe_slug = args.recipe_slug ?? "";
  if (!template_slug || !recipe_slug) {
    return { ok: false, data: { error: "template_slug and recipe_slug are required" } };
  }
  const resolved = await resolveConnectorTemplate({
    db: ctx.db,
    tenant_id: ctx.principal.tenant_id,
    slug: template_slug,
  });
  if (!resolved) {
    return { ok: false, data: { error: `unknown connector template \`${template_slug}\`` } };
  }
  const recipe = resolved.template.recipes.find((r) => r.slug === recipe_slug);
  if (!recipe) {
    return {
      ok: false,
      data: {
        error: `unknown recipe \`${recipe_slug}\` on template \`${template_slug}\` (available: ${resolved.template.recipes.map((r) => r.slug).join(", ")})`,
      },
    };
  }
  const wf = recipe.workflow as { steps?: Array<Record<string, unknown>> };
  const steps = (wf.steps ?? []).map(summarizeStep);
  return {
    ok: true,
    data: {
      template_slug,
      recipe_slug,
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
    },
  };
}
