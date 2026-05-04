// Connector-templates HTTP surface — entry point.
//
// Phase 4 §4.4 of the 2026-05 architecture audit (#92). The former
// http/routes/connector-templates.ts (949 LOC) split into per-sub-
// resource modules; this barrel registers shared per-path RBAC
// middleware and delegates handler registration to each module.
// Public API unchanged: server.ts still calls
// `registerConnectorTemplateRoutes(app)`.
//
//   GET    /v1/connector-templates                              — list built-ins + tenant overrides
//   POST   /v1/connector-templates                              — admin: add a tenant override
//   DELETE /v1/connector-templates/:id                          — admin: remove a tenant override
//   GET    /v1/connector-templates/:slug/recipes                — list recipes for a template
//   GET    /v1/connector-templates/:slug/recipes/:recipe_slug   — fetch a single recipe
//   GET    /v1/recipe-packs/:vertical                           — vertical recipe pack
//   POST   /v1/connectors/from-template/:slug                   — instantiate a connector
//   POST   /v1/connector-templates/:slug/oauth-credentials      — store OAuth client credentials
//   GET    /v1/connector-templates/match-url                    — match URL → templates
//   POST   /v1/connector-templates/import                       — import from spec

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
  // RBAC gating. Templates are read under connector:read and created /
  // deleted under connector:write. The legacy `requireAdmin` helper
  // still runs inside per-handler to preserve tenant-admin-only
  // behaviour, but the RBAC middleware is the authoritative gate.
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

  // Order matters for Hono: import / match-url paths are more specific
  // than `/v1/connector-templates/{slug}` so register them first; the
  // openapi + Hono routers tolerate either order, but it's cheap
  // insurance against future routing-resolution edge cases.
  registerImportRoutes(app);
  registerMatchUrlRoutes(app);
  registerCollectionRoutes(app);
  registerRecipeRoutes(app);
  registerOAuthRoutes(app);
  registerFromTemplateRoutes(app);
}
