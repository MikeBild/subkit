import type { OpenAPIHono } from "@hono/zod-openapi";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerCollectionRoutes } from "./collection.ts";
import { registerFromTemplateRoutes } from "./from-template.ts";
import { registerImportRoutes } from "./import-spec.ts";
import { registerMatchUrlRoutes } from "./match-url.ts";
import { registerOAuthRoutes } from "./oauth.ts";
import { registerRecipeRoutes } from "./recipes.ts";

export function registerConnectorTemplateRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/connector-templates", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/:id", async (c, next) => {
    if (c.req.method === "DELETE") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/:slug/oauth-credentials", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connectors/from-template/:slug", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/match-url", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/import", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/:slug/recipes", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/:slug/recipes/:recipe_slug", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    return next();
  });
  app.use("/v1/recipe-packs/:vertical", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    return next();
  });

  registerImportRoutes(app);
  registerMatchUrlRoutes(app);
  registerCollectionRoutes(app);
  registerRecipeRoutes(app);
  registerOAuthRoutes(app);
  registerFromTemplateRoutes(app);
}
