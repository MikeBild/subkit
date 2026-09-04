// What a person's approved MCP connections are, and how to end them.
//
// A "connection" is one client registration a person approved: the access
// and refresh tokens that carry it are its credentials, not separate things.
// Counting therefore counts DISTINCT client_id, so the number the Cockpit
// shows before a withdrawal matches what a person sees in the client — one
// connection, however many rotations it has been through.

import { and, eq, gt, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { mcpOauthAccessTokens, mcpOauthRefreshTokens, users } from "../db/schema/index.ts";

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
 *
 * Built with the query builder rather than raw SQL on purpose. The first
 * version asked `exec.execute(sql\`…\`)` and iterated the result — but the
 * node-postgres driver answers a `QueryResult` OBJECT, not an array, so the
 * route threw `TypeError: {} is not iterable` on every call. A cast
 * (`as unknown as Array<…>`) is what let that compile; there is no cast here,
 * and `.select()` returns rows typed as the array it really is.
 */
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

  // One connection per (client, person): a rotation chain and its access
  // token are one approval, not three.
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
