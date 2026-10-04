import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, paginatedResponse } from "../../../api/common-schemas.ts";
import { policy } from "../../../auth/index.ts";
import * as identity from "../../../identity/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { TenantSchema } from "./schemas.ts";

const TenantListResponse = paginatedResponse(TenantSchema, "TenantListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/v1/identity/tenants",
  tags: ["identity"],
  summary: "List tenants visible to the caller",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TenantListResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/identity/tenants/{id}",
  tags: ["identity"],
  summary: "Fetch a tenant",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TenantSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function serialize(t: NonNullable<Awaited<ReturnType<typeof identity.getTenant>>>) {
  return {
    id: t.id,
    slug: t.slug,
    display_name: t.display_name,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
  };
}

export function registerTenantRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/identity/tenants", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("identity:read")(c, next);
    return next();
  });
  app.use("/v1/identity/tenants/:id", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("identity:read")(c, next);
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "tenant" }, db);
    const items = await identity.listTenantsForPrincipal(principal.tenant_id, db);
    return c.json({ items: items.map(serialize) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "tenant" }, db);
    const { id } = c.req.valid("param");
    if (id !== principal.tenant_id) {
      throw new NotFoundError("tenant");
    }
    const t = await identity.getTenant(id, db);
    if (!t) throw new NotFoundError("tenant");
    return c.json(serialize(t), 200);
  });
}
