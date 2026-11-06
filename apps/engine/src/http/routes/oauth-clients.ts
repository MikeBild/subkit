import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { readRequestSource } from "../../audit/index.ts";
import { listOauthClientsForAdmin, revokeOauthClient } from "../../identity/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const OAuthClientSchema = z
  .object({
    id: z.string().uuid(),
    client_id: z.string(),
    client_name: z.string().nullable(),
    redirect_uris: z.array(z.string()),
    registration_source: z.enum(["dcr", "manual"]),
    approved_by: z.array(z.string()),
    live_connections: z.number().int().nonnegative(),
    connected_by: z.object({
      grants: z.array(
        z.object({
          user_id: z.string().uuid(),
          display_name: z.string().nullable(),
          email: z.string().email().nullable(),
          connected_at: z.string().datetime(),
          revoked_at: z.string().datetime().nullable(),
        }),
      ),
      has_unknown_legacy: z.boolean(),
    }),
    disabled_at: z.string().nullable(),
    retired_at: z.string().nullable(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .openapi("OAuthClient");

const OAuthClientListResponse = z
  .object({
    items: z.array(OAuthClientSchema),
  })
  .openapi("OAuthClientListResponse");

const ClientIdParam = z.object({ client_id: z.string().min(1) });

const OAuthClientRevokeResponse = z
  .object({
    client_id: z.string(),
    effect: z.enum(["client_disabled", "tenant_access_revoked"]),
  })
  .openapi("OAuthClientRevokeResult");

const listRoute = createRoute({
  method: "get",
  path: "/v1/oauth/clients",
  tags: ["oauth"],
  summary: "List registered MCP OAuth clients",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: OAuthClientListResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/v1/oauth/clients/{client_id}",
  tags: ["oauth"],
  summary:
    "Revoke a registered MCP OAuth client: the engine operator disables it for every tenant, everyone else revokes its grants and tokens in their own tenant",
  request: { params: ClientIdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Client disabled engine-wide, or its access in the caller's tenant revoked",
      content: { "application/json": { schema: OAuthClientRevokeResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerOAuthClientAdminRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/oauth/clients", (c, next) => {
    if (c.req.method === "GET") return requirePermission("mcp_oauth_client:read")(c, next);
    return next();
  });

  app.use("/v1/oauth/clients/:client_id", (c, next) => {
    if (c.req.method === "DELETE") {
      return requirePermission("mcp_oauth_client:revoke")(c, next);
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const { rows, approvals, connectedBy, lastUsage } = await listOauthClientsForAdmin(
      c.get("db"),
      { principal, request_source: readRequestSource(c) },
    );
    const items = rows.map((r) => {
      const approval = approvals.get(r.client_id);
      return {
        id: r.id,
        client_id: r.client_id,
        client_name: r.client_name ?? null,
        redirect_uris: r.redirect_uris,
        registration_source: r.registration_source,
        approved_by: approval?.approved_by ?? [],
        live_connections: approval?.live_connections ?? 0,
        connected_by: connectedBy.get(r.client_id) ?? {
          grants: [],
          has_unknown_legacy: false,
        },
        disabled_at: r.disabled_at ? r.disabled_at.toISOString() : null,
        retired_at: r.retired_at ? r.retired_at.toISOString() : null,
        created_at: r.created_at.toISOString(),
        last_used_at: lastUsage.get(r.client_id) ?? null,
      };
    });
    return c.json({ items }, 200);
  });

  app.openapi(revokeRoute, async (c) => {
    const principal = requireAuth(c);
    const { client_id } = c.req.valid("param");
    const effect = await revokeOauthClient(c.get("db"), {
      principal,
      client_id,
      request_source: readRequestSource(c),
    });
    if (!effect) throw new NotFoundError("mcp_oauth_client");
    return c.json({ client_id, effect }, 200);
  });
}
