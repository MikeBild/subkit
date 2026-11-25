import type { z } from "@hono/zod-openapi";
import { bindRecipe, listTemplateConnectors } from "../../connectors/recipe-binding.ts";
import { RECIPE_PACK_PREDICATES, type RecipePackVertical } from "../../connectors/recipe-packs.ts";
import {
  loadSolutionRecipes,
  SOLUTIONS_OUTCOME,
  SOLUTIONS_VERTICAL,
} from "../../connectors/solutions.ts";
import {
  listResolvedConnectorTemplates,
  resolveConnectorTemplate,
} from "../../connectors/template-resolver.ts";
import { type ConnectorRecipe, ConnectorRecipeSchema } from "../../connectors/templates.ts";
import {
  RecipeListResponseSchema,
  type RecipePackEntrySchema,
  RecipePackResponseSchema,
  RecipePackVerticalParam,
  RecipeSlugParam,
  TemplateSlugParam,
} from "./connector-template-representation.ts";
import { defineOperation, type OperationScope, reject } from "./index.ts";

type RecipeList = z.infer<typeof RecipeListResponseSchema>;
type RecipePack = z.infer<typeof RecipePackResponseSchema>;
type RecipePackEntry = z.infer<typeof RecipePackEntrySchema>;
type RecipeSlugInput = z.infer<typeof RecipeSlugParam>;

function pickRecipes(
  vertical: RecipePackVertical,
  templates: Awaited<ReturnType<typeof listResolvedConnectorTemplates>>,
): { outcome: string; picked: { template_slug: string | null; recipe: ConnectorRecipe }[] } {
  if (vertical === SOLUTIONS_VERTICAL) {
    return {
      outcome: SOLUTIONS_OUTCOME,
      picked: loadSolutionRecipes().map((recipe) => ({ template_slug: null, recipe })),
    };
  }
  const predicate = RECIPE_PACK_PREDICATES[vertical];
  const matchedCategories = new Set(predicate.match_categories);
  const matchedTags = new Set(predicate.match_tags);
  const picked: { template_slug: string | null; recipe: ConnectorRecipe }[] = [];
  for (const { template } of templates) {
    for (const recipe of template.recipes) {
      const categoryHit = matchedCategories.has(recipe.category);
      const tagHit = recipe.tags.some((t) => matchedTags.has(t));
      if (categoryHit || tagHit) picked.push({ template_slug: template.slug, recipe });
    }
  }
  return { outcome: predicate.outcome, picked };
}

async function recipePack(
  scope: OperationScope,
  vertical: RecipePackVertical,
): Promise<RecipePack> {
  const allTemplates = await listResolvedConnectorTemplates(scope.db, scope.tenant_id);
  const templates = new Map(
    allTemplates.map(({ template }) => [
      template.slug,
      { name: template.name, base_url: template.base_url },
    ]),
  );
  const { outcome, picked } = pickRecipes(vertical, allTemplates);
  const needed = new Set(
    picked.flatMap(({ recipe }) => recipe.required_connectors.map((r) => r.template)),
  );
  const available = await listTemplateConnectors(scope.tenant_id, [...needed], scope.db);
  const recipes: RecipePackEntry[] = picked.map(({ template_slug, recipe }) => {
    const bound = bindRecipe(recipe, available, templates);
    return {
      template_slug,
      recipe_slug: recipe.slug,
      title: recipe.title,
      description: recipe.description,
      category: recipe.category,
      tags: recipe.tags,
      difficulty: recipe.difficulty,
      connectors: bound.connectors,
      install_inputs: recipe.install_inputs,
      sample_input: recipe.sample_input ?? null,
      workflow: bound.workflow,
    };
  });
  return { vertical, outcome, recipes };
}

export const listTemplateRecipesOperation = defineOperation<{ readonly slug: string }, RecipeList>({
  id: "connector_template.recipes.list",
  summary: "List recipes shipped with a connector template",
  permission: "connector:read",
  effect: "read",
  async handler(scope, input) {
    const resolved = await resolveConnectorTemplate({
      db: scope.db,
      tenant_id: scope.tenant_id,
      slug: input.slug,
    });
    if (!resolved) return reject.notFound("connector_template");
    return {
      template_slug: resolved.template.slug,
      template_name: resolved.template.name,
      recipes: resolved.template.recipes,
    };
  },
  http: {
    method: "get",
    path: "/v1/connector-templates/{slug}/recipes",
    tags: ["connectors"],
    params: TemplateSlugParam,
    response: RecipeListResponseSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ slug: (param as { slug: string }).slug }),
    toBody: (result) => result,
  },
});

export const getTemplateRecipeOperation = defineOperation<RecipeSlugInput, ConnectorRecipe>({
  id: "connector_template.recipes.get",
  summary: "Get a single recipe by slug",
  permission: "connector:read",
  effect: "read",
  async handler(scope, input) {
    const resolved = await resolveConnectorTemplate({
      db: scope.db,
      tenant_id: scope.tenant_id,
      slug: input.slug,
    });
    if (!resolved) return reject.notFound("connector_template");
    const recipe = resolved.template.recipes.find((r) => r.slug === input.recipe_slug);
    return recipe ?? reject.notFound("connector_recipe");
  },
  http: {
    method: "get",
    path: "/v1/connector-templates/{slug}/recipes/{recipe_slug}",
    tags: ["connectors"],
    params: RecipeSlugParam,
    response: ConnectorRecipeSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => param as RecipeSlugInput,
    toBody: (result) => result,
  },
});

export const getRecipePackOperation = defineOperation<
  { readonly vertical: RecipePackVertical },
  RecipePack
>({
  id: "recipe_pack.get",
  summary:
    "Get a vertical recipe pack (computed from category + tags; `solutions` spans several connectors)",
  permission: "connector:read",
  effect: "read",
  handler: (scope, input) => recipePack(scope, input.vertical),
  http: {
    method: "get",
    path: "/v1/recipe-packs/{vertical}",
    tags: ["connectors"],
    params: RecipePackVerticalParam,
    response: RecipePackResponseSchema,
    toInput: ({ param }) => ({ vertical: (param as { vertical: RecipePackVertical }).vertical }),
    toBody: (result) => result,
  },
});
