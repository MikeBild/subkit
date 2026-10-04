import { and, eq, gt, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { mcpOauthAccessTokens, mcpOauthRefreshTokens, users } from "../db/schema/index.ts";

function liveAccess(tenantId: string, at: Date) {
  return and(
    eq(mcpOauthAccessTokens.tenant_id, tenantId),
    isNull(mcpOauthAccessTokens.revoked_at),
    gt(mcpOauthAccessTokens.expires_at, at),
  );
}

function liveRefresh(tenantId: string, at: Date) {
  return and(
    eq(mcpOauthRefreshTokens.tenant_id, tenantId),
    isNull(mcpOauthRefreshTokens.revoked_at),
    gt(mcpOauthRefreshTokens.expires_at, at),
  );
}

export async function countLiveConnectionsByUser(
  exec: Executor,
  tenantId: string,
  at: Date,
): Promise<Map<string, number>> {
  const accessRows = await exec
    .select({ user_id: mcpOauthAccessTokens.user_id, client_id: mcpOauthAccessTokens.client_id })
    .from(mcpOauthAccessTokens)
    .where(liveAccess(tenantId, at))
    .groupBy(mcpOauthAccessTokens.user_id, mcpOauthAccessTokens.client_id);
  const refreshRows = await exec
    .select({ user_id: mcpOauthRefreshTokens.user_id, client_id: mcpOauthRefreshTokens.client_id })
    .from(mcpOauthRefreshTokens)
    .where(liveRefresh(tenantId, at))
    .groupBy(mcpOauthRefreshTokens.user_id, mcpOauthRefreshTokens.client_id);

  const clientsByUser = new Map<string, Set<string>>();
  for (const r of [...accessRows, ...refreshRows]) {
    const clients = clientsByUser.get(r.user_id) ?? new Set<string>();
    clients.add(r.client_id);
    clientsByUser.set(r.user_id, clients);
  }

  const counts = new Map<string, number>();
  for (const [userId, clients] of clientsByUser) counts.set(userId, clients.size);
  return counts;
}

export interface ClientApproval {
  approved_by: string[];
  live_connections: number;
}

export async function listClientApprovals(
  exec: Executor,
  at: Date,
): Promise<Map<string, ClientApproval>> {
  // tenant-filter:exempt — mcp_oauth_clients is platform-global; the admin
  // route that calls this is platform-global for the same reason.
  const accessRows = await exec
    .select({ client_id: mcpOauthAccessTokens.client_id, email: users.email })
    .from(mcpOauthAccessTokens)
    .innerJoin(users, eq(users.id, mcpOauthAccessTokens.user_id))
    .where(and(isNull(mcpOauthAccessTokens.revoked_at), gt(mcpOauthAccessTokens.expires_at, at)));
  // tenant-filter:exempt — same platform-global surface
  const refreshRows = await exec
    .select({ client_id: mcpOauthRefreshTokens.client_id, email: users.email })
    .from(mcpOauthRefreshTokens)
    .innerJoin(users, eq(users.id, mcpOauthRefreshTokens.user_id))
    .where(and(isNull(mcpOauthRefreshTokens.revoked_at), gt(mcpOauthRefreshTokens.expires_at, at)));

  const peopleByClient = new Map<string, Set<string>>();
  for (const row of [...accessRows, ...refreshRows]) {
    const people = peopleByClient.get(row.client_id) ?? new Set<string>();
    people.add(row.email);
    peopleByClient.set(row.client_id, people);
  }

  const out = new Map<string, ClientApproval>();
  for (const [clientId, people] of peopleByClient) {
    const approved_by = [...people].sort();
    out.set(clientId, { approved_by, live_connections: approved_by.length });
  }
  return out;
}

export interface RevokedConnections {
  access_tokens: number;
  refresh_tokens: number;
  connections: number;
}

export async function revokeConnectionsForUser(
  exec: Executor,
  tenantId: string,
  userId: string,
  at: Date,
): Promise<RevokedConnections> {
  const access = await exec
    .update(mcpOauthAccessTokens)
    .set({ revoked_at: at })
    .where(
      and(
        eq(mcpOauthAccessTokens.tenant_id, tenantId),
        eq(mcpOauthAccessTokens.user_id, userId),
        isNull(mcpOauthAccessTokens.revoked_at),
      ),
    )
    .returning({ client_id: mcpOauthAccessTokens.client_id });

  const refresh = await exec
    .update(mcpOauthRefreshTokens)
    .set({ revoked_at: at })
    .where(
      and(
        eq(mcpOauthRefreshTokens.tenant_id, tenantId),
        eq(mcpOauthRefreshTokens.user_id, userId),
        isNull(mcpOauthRefreshTokens.revoked_at),
      ),
    )
    .returning({ client_id: mcpOauthRefreshTokens.client_id });

  const clients = new Set([...access, ...refresh].map((r) => r.client_id));
  return {
    access_tokens: access.length,
    refresh_tokens: refresh.length,
    connections: clients.size,
  };
}
