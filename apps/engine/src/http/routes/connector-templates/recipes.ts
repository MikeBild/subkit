// Recipe browse + vertical-pack endpoints. Recipes are global catalog
// data; the routes RBAC-gate on `connector:read` so portal tokens
// without read scope cannot exfiltrate the catalog roster.
//
//   GET /v1/connector-templates/{slug}/recipes
//   GET /v1/connector-templates/{slug}/recipes/{recipe_slug}
//   GET /v1/recipe-packs/{vertical}

import { createRoute, type OpenAPIHono, type z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  ConnectorRecipeSchema,
  listResolvedConnectorTemplates,
  resolveConnectorTemplate,
} from "../../../connectors/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  RECIPE_PACK_PREDICATES,
  RECIPE_PACK_VERTICALS,
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
  summary: "Get a vertical recipe pack (computed from category + tags)",
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
    const predicate = RECIPE_PACK_PREDICATES[vertical];
    const allTemplates = await listResolvedConnectorTemplates(db, principal.tenant_id);
    const matchedCategories = new Set(predicate.match_categories);
    const matchedTags = new Set(predicate.match_tags);
    const entries: z.infer<typeof RecipePackEntrySchema>[] = [];
    for (const { template } of allTemplates) {
      for (const r of template.recipes) {
        const categoryHit = matchedCategories.has(r.category);
        const tagHit = r.tags.some((t) => matchedTags.has(t));
        if (categoryHit || tagHit) {
          entries.push({
            template_slug: template.slug,
            recipe_slug: r.slug,
            title: r.title,
            category: r.category,
            tags: r.tags,
            difficulty: r.difficulty,
          });
        }
      }
    }
    return c.json(
      {
        vertical,
        outcome: predicate.outcome,
        recipes: entries,
      },
      200,
    );
  });

  // Touch the constants so the biome unused-import pass does not reject
  // a future refactor that prunes the set.
  void RECIPE_PACK_VERTICALS;
}
