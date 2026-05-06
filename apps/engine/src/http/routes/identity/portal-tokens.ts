// GET / POST / DELETE /v1/identity/portal-tokens

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { policy } from "../../../auth/index.ts";
import * as identity from "../../../identity/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { ErrorSchema, IdParam, PortalTokenIssuedSchema, PortalTokenSchema } from "./schemas.ts";

const PortalTokenListResponse = z
  .object({ items: z.array(PortalTokenSchema) })
  .openapi("PortalTokenListResponse");

const IssuePortalTokenBody = z
  .object({
    user_id: z.string().min(1),
    allowed_workflows: z.array(z.string()).min(1),
    ttl_minutes: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60)
      .optional(),
  })
  .openapi("IssuePortalTokenBody");

const listRoute = createRoute({
  method: "get",
  path: "/v1/identity/portal-tokens",
  tags: ["identity"],
  summary: "List portal tokens",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PortalTokenListResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const issueRoute = createRoute({
  method: "post",
  path: "/v1/identity/portal-tokens",
  tags: ["identity"],
  summary: "Issue a portal token",
  request: {
    body: { content: { "application/json": { schema: IssuePortalTokenBody } } },
  },
  security: [{ bearerAuth: [] }],
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: PortalTokenIssuedSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/v1/identity/portal-tokens/{id}",
  tags: ["identity"],
  summary: "Revoke a portal token",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Revoked" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function serialize(p: identity.PortalTokenView) {
  return {
    id: p.id,
    tenant_id: p.tenant_id,
    enduser_ref: p.enduser_ref,
    prefix: p.prefix,
    allowed_workflows: p.allowed_workflows,
    expires_at: p.expires_at.toISOString(),
    revoked_at: p.revoked_at ? p.revoked_at.toISOString() : null,
    created_at: p.created_at.toISOString(),
  };
}

export function registerPortalTokenRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC is enforced by the `requirePermission(...)` middleware below
  // (portal_token:read / portal_token:write / portal_token:revoke). The
  // legacy `enforce(adminOnly)` calls inside the handlers are strict
  // duplicates kept as defense-in-depth.
  app.use("/v1/identity/portal-tokens", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("portal_token:read")(c, next);
    if (c.req.method === "POST") return requirePermission("portal_token:write")(c, next);
    return next();
  });
  app.use("/v1/identity/portal-tokens/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "DELETE") {
      return requirePermission("portal_token:revoke", () => ({ type: "portal_token", id }))(
        c,
        next,
      );
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "portal_token" }, db);
    const items = await identity.listPortalTokens(principal.tenant_id, db);
    return c.json({ items: items.map(serialize) }, 200);
  });

  app.openapi(issueRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "portal_token" }, db);
    const body = c.req.valid("json");
    const result = await identity.issuePortalToken(
      {
        tenant_id: principal.tenant_id,
        user_id: body.user_id,
        allowed_workflows: body.allowed_workflows,
        ...(body.ttl_minutes !== undefined ? { ttl_minutes: body.ttl_minutes } : {}),
        actor_id: principal.id,
      },
      db,
    );
    return c.json(
      {
        ...serialize(result.view),
        plaintext_token: result.plaintext,
      },
      201,
    );
  });

  app.openapi(revokeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "portal_token" }, db);
    const { id } = c.req.valid("param");
    const row = await identity.revokePortalToken(
      {
        tenant_id: principal.tenant_id,
        id,
        actor_id: principal.id,
      },
      db,
    );
    if (!row) throw new NotFoundError("portal_token");
    return c.body(null, 204);
  });
}
