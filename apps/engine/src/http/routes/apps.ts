import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { AppIdParam, AppListResponseSchema, AppViewSchema } from "../../api/app-schemas.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { type AppTenant, getApp, listApps } from "../../execution/index.ts";
import { getTenant } from "../../identity/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const errorResponses = {
  401: { description: "Unauthenticated", content: { "application/json": { schema: ErrorSchema } } },
  403: {
    description: "Missing settings:read; product principals are always refused",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const listRoute = createRoute({
  method: "get",
  path: "/v1/apps",
  tags: ["identity"],
  summary: "List the apps visible to the caller's workspace",
  description:
    "Read-only view derived from products settings, sign-in providers, workflows, signed-in identities and the caller budget ledger. An app is visible when a provider of this workspace, a workflow of this workspace or a signed-in identity carries its product_id, or when its assistant workflow belongs to this workspace. Changes go through settings revisions.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Apps of the workspace",
      content: { "application/json": { schema: AppListResponseSchema } },
    },
    ...errorResponses,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/apps/{id}",
  tags: ["identity"],
  summary: "Read one app with its sign-in, workflows, readiness checks and today's budget",
  security: [{ bearerAuth: [] }],
  request: { params: AppIdParam },
  responses: {
    200: { description: "The app", content: { "application/json": { schema: AppViewSchema } } },
    ...errorResponses,
    404: {
      description: "No app with this id is visible to the workspace",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

async function tenantOf(db: Db, tenant_id: string): Promise<AppTenant> {
  const tenant = await getTenant(tenant_id, db);
  if (!tenant) throw new NotFoundError("tenant");
  return { tenant_id, tenant_slug: tenant.slug };
}

export function registerAppRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/apps", requirePermission("settings:read"));
  app.use("/v1/apps/*", requirePermission("settings:read"));

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await listApps(db, await tenantOf(db, principal.tenant_id), getConfig());
    return c.json({ items }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const view = await getApp(
      db,
      await tenantOf(db, principal.tenant_id),
      getConfig(),
      c.req.valid("param").id,
    );
    if (!view) throw new NotFoundError("app");
    return c.json(view, 200);
  });
}
