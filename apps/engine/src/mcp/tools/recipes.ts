// MCP `list_recipes` product tool.
//
// list_recipes has no conversation-tool counterpart and lives here as
// a truly MCP-unique handler. The legacy inspect_recipe MCP duplicate
// was removed in the unified-palette refactor — the conversation-side
// `inspect_recipe` tool (see `apps/engine/src/conversations/tools/
// inspect-recipe.ts`) serves both surfaces via the unified dispatcher.
//
// Stateless beyond a tenant-scope template lookup. No audit beyond the
// standard `tool.dispatch.invoke` log.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { resolveConnectorTemplate } from "../../connectors/template-resolver.ts";
import type { ConnectorRecipe } from "../../connectors/templates.ts";
import type { Db } from "../../db/client.ts";

export const LIST_RECIPES_TOOL_NAME = "list_recipes";

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
