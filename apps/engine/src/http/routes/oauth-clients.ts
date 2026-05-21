// Admin surface for platform-global MCP OAuth clients.
//
// GET  /v1/oauth/clients          — list registered clients (no secrets)
// DELETE /v1/oauth/clients/{client_id} — soft-disable a client
//
// These are AUTHENTICATED admin-only routes. Unlike the bootstrap OAuth
// routes in routes/oauth.ts, they require a bearer token and the
// mcp_oauth_client:read / mcp_oauth_client:revoke permission.
//
// mcp_oauth_clients has no tenant_id (DCR registers clients pre-tenant).
// Routes are platform-global and admin-gated for that reason.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait, readRequestSource } from "../../audit/index.ts";
import { mcpOauthClients } from "../../db/schema/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const OAuthClientSchema = z
  .object({
    id: z.string().uuid(),
    client_id: z.string(),
    client_name: z.string().nullable(),
    redirect_uris: z.array(z.string()),
    registration_source: z.enum(["dcr", "manual"]),
    disabled_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("OAuthClient");

const OAuthClientListResponse = z
  .object({
    items: z.array(OAuthClientSchema),
  })
  .openapi("OAuthClientListResponse");

const ClientIdParam = z.object({ client_id: z.string().min(1) });

// ── Route definitions ────────────────────────────────────────────────────────

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
  summary: "Disable a registered MCP OAuth client",
  request: { params: ClientIdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Disabled" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Registration ─────────────────────────────────────────────────────────────

export function registerOAuthClientAdminRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/oauth/clients", (c, next) => {
    if (c.req.method === "GET") return requirePermission("mcp_oauth_client:read")(c, next);
    return next();
  });

  app.use("/v1/oauth/clients/:client_id", (c, next) => {
    const client_id = c.req.param("client_id");
    if (c.req.method === "DELETE") {
      return requirePermission("mcp_oauth_client:revoke", () => ({
        type: "mcp_oauth_client",
        id: client_id,
      }))(c, next);
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    requireAuth(c);
    const db = c.get("db");
    // tenant-filter:exempt — mcp_oauth_clients has no tenant_id; admin-only route
    const rows = await db
      .select({
        id: mcpOauthClients.id,
        client_id: mcpOauthClients.client_id,
        client_name: mcpOauthClients.client_name,
        redirect_uris: mcpOauthClients.redirect_uris,
        registration_source: mcpOauthClients.registration_source,
        disabled_at: mcpOauthClients.disabled_at,
        created_at: mcpOauthClients.created_at,
      })
      .from(mcpOauthClients);

    const items = rows.map((r) => ({
      id: r.id,
      client_id: r.client_id,
      client_name: r.client_name ?? null,
      redirect_uris: r.redirect_uris,
      registration_source: r.registration_source,
      disabled_at: r.disabled_at ? r.disabled_at.toISOString() : null,
      created_at: r.created_at.toISOString(),
    }));

    return c.json({ items }, 200);
  });

  app.openapi(revokeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { client_id } = c.req.valid("param");

    // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
    const rows = await db
      .select({ id: mcpOauthClients.id, disabled_at: mcpOauthClients.disabled_at })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, client_id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("mcp_oauth_client");

    const now = new Date();
    // Idempotent: if already disabled, return 204 without a second audit row.
    if (!row.disabled_at) {
      await db
        .update(mcpOauthClients)
        .set({ disabled_at: now })
        .where(eq(mcpOauthClients.client_id, client_id));

      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.MCP_OAUTH_CLIENT_DISABLED,
          resource_type: "mcp_oauth_client",
          resource_id: row.id,
          result: "success",
          metadata: {
            client_id,
            request_source: readRequestSource(c),
          },
        },
        db,
      );
    }

    return c.body(null, 204);
  });
}
