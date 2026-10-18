import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait, readRequestSource } from "../../audit/index.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
} from "../../db/schema/index.ts";
import {
  listClientApprovals,
  listClientConnectedBy,
  listClientLastUsage,
  listTenantClientIds,
  revokeClientAccessForTenant,
} from "../../identity/index.ts";
import { principalHolds } from "../../rbac/index.ts";
import { now } from "../../utils/clock.ts";
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

function disablesEngineWide(
  db: AppEnv["Variables"]["db"],
  principal: ReturnType<typeof requireAuth>,
): Promise<boolean> {
  return principalHolds(db, principal, "mcp_oauth_client:disable");
}

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
        retired_at: mcpOauthClients.retired_at,
        created_at: mcpOauthClients.created_at,
      })
      .from(mcpOauthClients);

    const [approvals, connectedBy, lastUsage, engineWide, tenantClients] = await Promise.all([
      listClientApprovals(db, principal.tenant_id, new Date(now())),
      listClientConnectedBy(db, principal.tenant_id),
      listClientLastUsage(db, principal.tenant_id),
      disablesEngineWide(db, principal),
      listTenantClientIds(db, principal.tenant_id),
    ]);

    const visible = engineWide ? rows : rows.filter((r) => tenantClients.has(r.client_id));
    const items = visible.map((r) => {
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

    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.MCP_OAUTH_CLIENT_LISTED,
        resource_type: "mcp_oauth_client",
        resource_id: null,
        result: "success",
        metadata: {
          request_source: readRequestSource(c),
          count: items.length,
        },
      },
      db,
    );

    return c.json({ items }, 200);
  });

  app.openapi(revokeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { client_id } = c.req.valid("param");

    // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
    const rows = await db
      .select({
        id: mcpOauthClients.id,
        disabled_at: mcpOauthClients.disabled_at,
        retired_at: mcpOauthClients.retired_at,
      })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, client_id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("mcp_oauth_client");

    if (!(await disablesEngineWide(db, principal))) {
      if (!(await listTenantClientIds(db, principal.tenant_id)).has(client_id)) {
        throw new NotFoundError("mcp_oauth_client");
      }
      await db.transaction(async (tx) => {
        const revoked = await revokeClientAccessForTenant(
          tx,
          principal.tenant_id,
          client_id,
          new Date(now()),
        );
        await auditAwait(
          {
            tenant_id: principal.tenant_id,
            actor_type: principal.kind,
            actor_id: principal.id,
            action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
            resource_type: "mcp_oauth_token",
            resource_id: row.id,
            result: "success",
            metadata: {
              request_source: readRequestSource(c),
              reason: "tenant_access_revoked",
              client_id,
              access_tokens_revoked: revoked.access_tokens,
              refresh_tokens_revoked: revoked.refresh_tokens,
            },
          },
          tx,
        );
      });
      return c.json({ client_id, effect: "tenant_access_revoked" as const }, 200);
    }

    await db.transaction(async (tx) => {
      // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
      const [lockedClient] = await tx
        .select({
          id: mcpOauthClients.id,
          disabled_at: mcpOauthClients.disabled_at,
          retired_at: mcpOauthClients.retired_at,
        })
        .from(mcpOauthClients)
        .where(eq(mcpOauthClients.client_id, client_id))
        .for("update");
      if (!lockedClient || (lockedClient.disabled_at && !lockedClient.retired_at)) return;

      const now = new Date();
      await tx
        .update(mcpOauthClients)
        .set({ disabled_at: now, retired_at: null })
        .where(eq(mcpOauthClients.client_id, client_id));

      const revokedAccess = await tx
        .update(mcpOauthAccessTokens)
        .set({ revoked_at: now })
        .where(
          and(
            eq(mcpOauthAccessTokens.client_id, client_id),
            isNull(mcpOauthAccessTokens.revoked_at),
          ),
        )
        .returning({
          id: mcpOauthAccessTokens.id,
          tenant_id: mcpOauthAccessTokens.tenant_id,
          grant_id: mcpOauthAccessTokens.grant_id,
        });
      const revokedRefresh = await tx
        .update(mcpOauthRefreshTokens)
        .set({ revoked_at: now })
        .where(
          and(
            eq(mcpOauthRefreshTokens.client_id, client_id),
            isNull(mcpOauthRefreshTokens.revoked_at),
          ),
        )
        .returning({
          id: mcpOauthRefreshTokens.id,
          tenant_id: mcpOauthRefreshTokens.tenant_id,
          grant_id: mcpOauthRefreshTokens.grant_id,
        });

      const legacyTenants = new Set(
        [...revokedAccess, ...revokedRefresh]
          .filter((token) => token.grant_id === null)
          .map((token) => token.tenant_id),
      );
      for (const tenant_id of legacyTenants) {
        await tx
          .insert(mcpOauthUnknownGrants)
          .values({ tenant_id, client_id })
          .onConflictDoNothing();
      }

      // tenant-filter:exempt — OAuth client revocation is platform-global and permission-gated.
      await tx
        .update(mcpOauthGrants)
        .set({ revoked_at: now })
        .where(and(eq(mcpOauthGrants.client_id, client_id), isNull(mcpOauthGrants.revoked_at)));

      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.MCP_OAUTH_CLIENT_DISABLED,
          resource_type: "mcp_oauth_client",
          resource_id: lockedClient.id,
          result: "success",
          metadata: {
            client_id,
            request_source: readRequestSource(c),
          },
        },
        tx,
      );

      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
          resource_type: "mcp_oauth_token",
          resource_id: lockedClient.id,
          result: "success",
          metadata: {
            request_source: readRequestSource(c),
            reason: "client_disabled",
            client_id,
            access_tokens_revoked: revokedAccess.length,
            refresh_tokens_revoked: revokedRefresh.length,
          },
        },
        tx,
      );
    });

    return c.json({ client_id, effect: "client_disabled" as const }, 200);
  });
}
