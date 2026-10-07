import { createRoute, type OpenAPIHono, type z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  bindRecipe,
  type ConnectorRecipe,
  ConnectorRecipeSchema,
  listResolvedConnectorTemplates,
  listTemplateConnectors,
  loadSolutionRecipes,
  resolveConnectorTemplate,
  SOLUTIONS_OUTCOME,
  SOLUTIONS_VERTICAL,
} from "../../../connectors/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  RECIPE_PACK_PREDICATES,
  RecipeListResponseSchema,
  type RecipePackEntrySchema,
  RecipePackResponseSchema,
  RecipePackVerticalParam,
  RecipeSlugParam,
  TemplateSlugParam,
} from "./schemas.ts";

const recipeListRoute = createRoute({
  method: "get",
  path: "/v1/connector-templates/{slug}/recipes",
  tags: ["connectors"],
  summary: "List recipes shipped with a connector template",
  security: [{ bearerAuth: [] }],
  request: { params: TemplateSlugParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: RecipeListResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const recipeGetRoute = createRoute({
  method: "get",
  path: "/v1/connector-templates/{slug}/recipes/{recipe_slug}",
  tags: ["connectors"],
  summary: "Get a single recipe by slug",
  security: [{ bearerAuth: [] }],
  request: { params: RecipeSlugParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConnectorRecipeSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const recipePackRoute = createRoute({
  method: "get",
  path: "/v1/recipe-packs/{vertical}",
  tags: ["connectors"],
  summary:
    "Get a vertical recipe pack (computed from category + tags; `solutions` spans several connectors)",
  security: [{ bearerAuth: [] }],
  request: { params: RecipePackVerticalParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: RecipePackResponseSchema } },
    },
  },
});

export function registerRecipeRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(recipeListRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { slug } = c.req.valid("param");
    const resolved = await resolveConnectorTemplate({
      db,
      tenant_id: principal.tenant_id,
      slug,
    });
    if (!resolved) throw new NotFoundError("connector_template");
    return c.json(
      {
        template_slug: resolved.template.slug,
        template_name: resolved.template.name,
        recipes: resolved.template.recipes,
      },
      200,
    );
  });

  app.openapi(recipeGetRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { slug, recipe_slug } = c.req.valid("param");
    const resolved = await resolveConnectorTemplate({
      db,
      tenant_id: principal.tenant_id,
      slug,
    });
    if (!resolved) throw new NotFoundError("connector_template");
    const recipe = resolved.template.recipes.find((r) => r.slug === recipe_slug);
    if (!recipe) throw new NotFoundError("connector_recipe");
    return c.json(recipe, 200);
  });

  app.openapi(recipePackRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { vertical } = c.req.valid("param");
    const allTemplates = await listResolvedConnectorTemplates(db, principal.tenant_id);
    const templates = new Map(
      allTemplates.map(({ template }) => [
        template.slug,
        { name: template.name, base_url: template.base_url },
      ]),
    );
    const picked: { template_slug: string | null; recipe: ConnectorRecipe }[] = [];
    let outcome: string;
    if (vertical === SOLUTIONS_VERTICAL) {
      outcome = SOLUTIONS_OUTCOME;
      for (const recipe of loadSolutionRecipes()) picked.push({ template_slug: null, recipe });
    } else {
      const predicate = RECIPE_PACK_PREDICATES[vertical];
      outcome = predicate.outcome;
      const matchedCategories = new Set(predicate.match_categories);
      const matchedTags = new Set(predicate.match_tags);
      for (const { template } of allTemplates) {
        for (const recipe of template.recipes) {
          const categoryHit = matchedCategories.has(recipe.category);
          const tagHit = recipe.tags.some((t) => matchedTags.has(t));
          if (categoryHit || tagHit) picked.push({ template_slug: template.slug, recipe });
        }
      }
    }
    const needed = new Set(
      picked.flatMap(({ recipe }) => recipe.required_connectors.map((r) => r.template)),
    );
    const available = await listTemplateConnectors(principal.tenant_id, [...needed], db);
    const entries: z.infer<typeof RecipePackEntrySchema>[] = picked.map(
      ({ template_slug, recipe }) => {
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
          sample_input: recipe.sample_input ?? null,
          workflow: bound.workflow as unknown as Record<string, unknown>,
        };
      },
    );
    return c.json({ vertical, outcome, recipes: entries }, 200);
  });
}
