// What a person's approved MCP connections are, and how to end them.
//
// A "connection" is one client registration a person approved: the access
// and refresh tokens that carry it are its credentials, not separate things.
// Counting therefore counts DISTINCT client_id, so the number the Cockpit
// shows before a withdrawal matches what a person sees in the client — one
// connection, however many rotations it has been through.

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { mcpOauthAccessTokens, mcpOauthRefreshTokens } from "../db/schema/index.ts";

/** A live token: not revoked, not yet expired. */
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

/**
 * How many live connections each person in the tenant holds, keyed by user id.
 * People with none are absent from the map — the caller reads `?? 0`.
 */
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

  // One connection = one client registration a person approved, so the
  // clients are collected per person rather than counted per token row.
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
  /** Emails of the people whose approval keeps this client connected. */
  approved_by: string[];
  /** Live connections for this client, one per approving person. */
  live_connections: number;
}

/**
 * Who approved each registered client, read off the live token rows. The
 * connections page shows this so a revocation is never a shot in the dark.
 */
export async function listClientApprovals(
  exec: Executor,
  at: Date,
): Promise<Map<string, ClientApproval>> {
  // tenant-filter:exempt — mcp_oauth_clients is platform-global; the admin
  // route that calls this is platform-global for the same reason.
  const rows = await exec.execute(sql`
    SELECT client_id, email
    FROM (
      SELECT t.client_id AS client_id, u.email AS email
      FROM mcp_oauth_access_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.revoked_at IS NULL AND t.expires_at > ${at}
      UNION
      SELECT r.client_id AS client_id, u.email AS email
      FROM mcp_oauth_refresh_tokens r
      JOIN users u ON u.id = r.user_id
      WHERE r.revoked_at IS NULL AND r.expires_at > ${at}
    ) AS approvals
    ORDER BY client_id, email
  `);

  const out = new Map<string, ClientApproval>();
  for (const raw of rows as unknown as Array<{ client_id: string; email: string }>) {
    const entry = out.get(raw.client_id) ?? { approved_by: [], live_connections: 0 };
    entry.approved_by.push(raw.email);
    entry.live_connections += 1;
    out.set(raw.client_id, entry);
  }
  return out;
}

export interface RevokedConnections {
  access_tokens: number;
  refresh_tokens: number;
  /** Distinct client registrations that stopped working. */
  connections: number;
}

/**
 * End every OAuth connection this person approved. Called from inside the
 * withdrawal transaction so there is no window in which the account is
 * disabled and its tokens are still live.
 */
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
