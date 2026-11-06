import { and, eq, isNull } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
} from "../db/schema/index.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import { principalHolds } from "../rbac/index.ts";
import { now } from "../utils/clock.ts";
import {
  type ClientApproval,
  type ClientConnectedBy,
  listClientApprovals,
  listClientConnectedBy,
  listClientLastUsage,
  listTenantClientIds,
  revokeClientAccessForTenant,
} from "./oauth-connections.ts";

export interface OAuthClientAdminInput {
  principal: ResolvedPrincipal;
  request_source: RequestSource | undefined;
}

export type OAuthClientRow = Pick<
  typeof mcpOauthClients.$inferSelect,
  | "id"
  | "client_id"
  | "client_name"
  | "redirect_uris"
  | "registration_source"
  | "disabled_at"
  | "retired_at"
  | "created_at"
>;

export interface OAuthClientListing {
  rows: OAuthClientRow[];
  approvals: Map<string, ClientApproval>;
  connectedBy: Map<string, ClientConnectedBy>;
  lastUsage: Map<string, string>;
}

export type OAuthClientRevokeEffect = "client_disabled" | "tenant_access_revoked";

function disablesEngineWide(db: Db, principal: ResolvedPrincipal): Promise<boolean> {
  return principalHolds(db, principal, "mcp_oauth_client:disable");
}

export async function listOauthClientsForAdmin(
  db: Db,
  input: OAuthClientAdminInput,
): Promise<OAuthClientListing> {
  const { principal } = input;
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
        request_source: input.request_source,
        count: visible.length,
      },
    },
    db,
  );

  return { rows: visible, approvals, connectedBy, lastUsage };
}

export async function revokeOauthClient(
  db: Db,
  input: OAuthClientAdminInput & { client_id: string },
): Promise<OAuthClientRevokeEffect | null> {
  const { principal, client_id } = input;
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
  if (!row) return null;

  if (!(await disablesEngineWide(db, principal))) {
    if (!(await listTenantClientIds(db, principal.tenant_id)).has(client_id)) {
      return null;
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
            request_source: input.request_source,
            reason: "tenant_access_revoked",
            client_id,
            access_tokens_revoked: revoked.access_tokens,
            refresh_tokens_revoked: revoked.refresh_tokens,
          },
        },
        tx,
      );
    });
    return "tenant_access_revoked";
  }

  await disableOauthClientEngineWide(db, input);
  return "client_disabled";
}

async function disableOauthClientEngineWide(
  db: Db,
  input: OAuthClientAdminInput & { client_id: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
    const [lockedClient] = await tx
      .select({
        id: mcpOauthClients.id,
        disabled_at: mcpOauthClients.disabled_at,
        retired_at: mcpOauthClients.retired_at,
      })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, input.client_id))
      .for("update");
    if (!lockedClient || (lockedClient.disabled_at && !lockedClient.retired_at)) return;

    const now = new Date();
    await tx
      .update(mcpOauthClients)
      .set({ disabled_at: now, retired_at: null })
      .where(eq(mcpOauthClients.client_id, input.client_id));

    const revokedAccess = await tx
      .update(mcpOauthAccessTokens)
      .set({ revoked_at: now })
      .where(
        and(
          eq(mcpOauthAccessTokens.client_id, input.client_id),
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
          eq(mcpOauthRefreshTokens.client_id, input.client_id),
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
        .values({ tenant_id, client_id: input.client_id })
        .onConflictDoNothing();
    }

    // tenant-filter:exempt — OAuth client revocation is platform-global and permission-gated.
    await tx
      .update(mcpOauthGrants)
      .set({ revoked_at: now })
      .where(and(eq(mcpOauthGrants.client_id, input.client_id), isNull(mcpOauthGrants.revoked_at)));

    await auditAwait(
      {
        tenant_id: input.principal.tenant_id,
        actor_type: input.principal.kind,
        actor_id: input.principal.id,
        action: AuditAction.MCP_OAUTH_CLIENT_DISABLED,
        resource_type: "mcp_oauth_client",
        resource_id: lockedClient.id,
        result: "success",
        metadata: {
          client_id: input.client_id,
          request_source: input.request_source,
        },
      },
      tx,
    );

    await auditAwait(
      {
        tenant_id: input.principal.tenant_id,
        actor_type: input.principal.kind,
        actor_id: input.principal.id,
        action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
        resource_type: "mcp_oauth_token",
        resource_id: lockedClient.id,
        result: "success",
        metadata: {
          request_source: input.request_source,
          reason: "client_disabled",
          client_id: input.client_id,
          access_tokens_revoked: revokedAccess.length,
          refresh_tokens_revoked: revokedRefresh.length,
        },
      },
      tx,
    );
  });
}
