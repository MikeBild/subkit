import { and, eq, gt, isNotNull, isNull, max } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
  users,
} from "../db/schema/index.ts";

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

export interface ClientConnectedByGrant {
  user_id: string;
  display_name: string | null;
  email: string | null;
  connected_at: string;
  revoked_at: string | null;
}

export interface ClientConnectedBy {
  grants: ClientConnectedByGrant[];
  has_unknown_legacy: boolean;
}

export async function listClientConnectedBy(
  exec: Executor,
  tenantId: string,
): Promise<Map<string, ClientConnectedBy>> {
  const out = new Map<string, ClientConnectedBy>();

  const grantRows = await exec
    .select({
      client_id: mcpOauthGrants.client_id,
      user_id: mcpOauthGrants.user_id,
      display_name: users.display_name,
      email: users.email,
      connected_at: mcpOauthGrants.connected_at,
      revoked_at: mcpOauthGrants.revoked_at,
    })
    .from(mcpOauthGrants)
    .where(eq(mcpOauthGrants.tenant_id, tenantId))
    .leftJoin(
      users,
      and(eq(users.id, mcpOauthGrants.user_id), eq(users.tenant_id, mcpOauthGrants.tenant_id)),
    )
    .orderBy(mcpOauthGrants.connected_at);

  for (const row of grantRows) {
    const entry = out.get(row.client_id) ?? { grants: [], has_unknown_legacy: false };
    entry.grants.push({
      user_id: row.user_id,
      display_name: row.display_name ?? null,
      email: row.email ?? null,
      connected_at: row.connected_at.toISOString(),
      revoked_at: row.revoked_at?.toISOString() ?? null,
    });
    out.set(row.client_id, entry);
  }

  const legacyAccess = await exec
    .select({ client_id: mcpOauthAccessTokens.client_id })
    .from(mcpOauthAccessTokens)
    .where(
      and(eq(mcpOauthAccessTokens.tenant_id, tenantId), isNull(mcpOauthAccessTokens.grant_id)),
    );
  const legacyRefresh = await exec
    .select({ client_id: mcpOauthRefreshTokens.client_id })
    .from(mcpOauthRefreshTokens)
    .where(
      and(eq(mcpOauthRefreshTokens.tenant_id, tenantId), isNull(mcpOauthRefreshTokens.grant_id)),
    );

  const unknownClientIds = new Set([...legacyAccess, ...legacyRefresh].map((r) => r.client_id));
  const persistedUnknowns = await exec
    .select({ client_id: mcpOauthUnknownGrants.client_id })
    .from(mcpOauthUnknownGrants)
    .where(eq(mcpOauthUnknownGrants.tenant_id, tenantId));
  for (const row of persistedUnknowns) unknownClientIds.add(row.client_id);

  for (const clientId of unknownClientIds) {
    const entry = out.get(clientId) ?? { grants: [], has_unknown_legacy: false };
    entry.has_unknown_legacy = true;
    out.set(clientId, entry);
  }

  return out;
}

export async function listClientLastUsage(
  exec: Executor,
  tenantId: string,
): Promise<Map<string, string>> {
  const rows = await exec
    .select({
      client_id: mcpOauthAccessTokens.client_id,
      last_used_at: max(mcpOauthAccessTokens.last_used_at),
    })
    .from(mcpOauthAccessTokens)
    .where(
      and(
        eq(mcpOauthAccessTokens.tenant_id, tenantId),
        isNotNull(mcpOauthAccessTokens.last_used_at),
      ),
    )
    .groupBy(mcpOauthAccessTokens.client_id);
  const usage = new Map<string, string>();
  for (const row of rows) {
    if (row.last_used_at) usage.set(row.client_id, new Date(row.last_used_at).toISOString());
  }
  return usage;
}

export async function listClientApprovals(
  exec: Executor,
  tenantId: string,
  at: Date,
): Promise<Map<string, ClientApproval>> {
  const accessRows = await exec
    .select({ client_id: mcpOauthAccessTokens.client_id, email: users.email })
    .from(mcpOauthAccessTokens)
    .innerJoin(
      users,
      and(
        eq(users.id, mcpOauthAccessTokens.user_id),
        eq(users.tenant_id, mcpOauthAccessTokens.tenant_id),
      ),
    )
    .where(
      and(
        eq(mcpOauthAccessTokens.tenant_id, tenantId),
        isNull(mcpOauthAccessTokens.revoked_at),
        gt(mcpOauthAccessTokens.expires_at, at),
      ),
    );
  const refreshRows = await exec
    .select({ client_id: mcpOauthRefreshTokens.client_id, email: users.email })
    .from(mcpOauthRefreshTokens)
    .innerJoin(
      users,
      and(
        eq(users.id, mcpOauthRefreshTokens.user_id),
        eq(users.tenant_id, mcpOauthRefreshTokens.tenant_id),
      ),
    )
    .where(
      and(
        eq(mcpOauthRefreshTokens.tenant_id, tenantId),
        isNull(mcpOauthRefreshTokens.revoked_at),
        gt(mcpOauthRefreshTokens.expires_at, at),
      ),
    );

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
  const accessClientRows = await exec
    .select({ client_id: mcpOauthAccessTokens.client_id })
    .from(mcpOauthAccessTokens)
    .where(
      and(eq(mcpOauthAccessTokens.tenant_id, tenantId), eq(mcpOauthAccessTokens.user_id, userId)),
    );
  const refreshClientRows = await exec
    .select({ client_id: mcpOauthRefreshTokens.client_id })
    .from(mcpOauthRefreshTokens)
    .where(
      and(eq(mcpOauthRefreshTokens.tenant_id, tenantId), eq(mcpOauthRefreshTokens.user_id, userId)),
    );
  const grantClientRows = await exec
    .select({ client_id: mcpOauthGrants.client_id })
    .from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.tenant_id, tenantId), eq(mcpOauthGrants.user_id, userId)));
  const clientIds = [
    ...new Set(
      [...accessClientRows, ...refreshClientRows, ...grantClientRows].map((row) => row.client_id),
    ),
  ].sort();

  for (const client_id of clientIds) {
    // tenant-filter:exempt — clients are global; IDs come from this tenant's OAuth rows.
    await exec
      .select({ client_id: mcpOauthClients.client_id })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, client_id))
      .for("update");
  }

  await exec
    .select({ id: mcpOauthGrants.id })
    .from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.tenant_id, tenantId), eq(mcpOauthGrants.user_id, userId)))
    .orderBy(mcpOauthGrants.id)
    .for("update");
  await exec
    .select({ id: mcpOauthRefreshTokens.id })
    .from(mcpOauthRefreshTokens)
    .where(
      and(eq(mcpOauthRefreshTokens.tenant_id, tenantId), eq(mcpOauthRefreshTokens.user_id, userId)),
    )
    .orderBy(mcpOauthRefreshTokens.id)
    .for("update");
  await exec
    .select({ id: mcpOauthAccessTokens.id })
    .from(mcpOauthAccessTokens)
    .where(
      and(eq(mcpOauthAccessTokens.tenant_id, tenantId), eq(mcpOauthAccessTokens.user_id, userId)),
    )
    .orderBy(mcpOauthAccessTokens.id)
    .for("update");

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
    .returning({
      client_id: mcpOauthAccessTokens.client_id,
      grant_id: mcpOauthAccessTokens.grant_id,
    });

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
    .returning({
      client_id: mcpOauthRefreshTokens.client_id,
      grant_id: mcpOauthRefreshTokens.grant_id,
    });

  const legacyClientIds = new Set(
    [...access, ...refresh].filter((row) => row.grant_id === null).map((row) => row.client_id),
  );
  if (legacyClientIds.size > 0) {
    await exec
      .insert(mcpOauthUnknownGrants)
      .values([...legacyClientIds].map((client_id) => ({ tenant_id: tenantId, client_id })))
      .onConflictDoNothing();
  }

  await exec
    .update(mcpOauthGrants)
    .set({ revoked_at: at })
    .where(
      and(
        eq(mcpOauthGrants.tenant_id, tenantId),
        eq(mcpOauthGrants.user_id, userId),
        isNull(mcpOauthGrants.revoked_at),
      ),
    );

  const clients = new Set([...access, ...refresh].map((r) => r.client_id));
  return {
    access_tokens: access.length,
    refresh_tokens: refresh.length,
    connections: clients.size,
  };
}

export async function revokeClientAccessForTenant(
  exec: Executor,
  tenantId: string,
  clientId: string,
  at: Date,
): Promise<{ access_tokens: number; refresh_tokens: number }> {
  // tenant-filter:exempt — clients are global; the lock serializes with refresh rotation.
  await exec
    .select({ client_id: mcpOauthClients.client_id })
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.client_id, clientId))
    .for("update");
  await exec
    .select({ id: mcpOauthGrants.id })
    .from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.tenant_id, tenantId), eq(mcpOauthGrants.client_id, clientId)))
    .orderBy(mcpOauthGrants.id)
    .for("update");
  await exec
    .select({ id: mcpOauthRefreshTokens.id })
    .from(mcpOauthRefreshTokens)
    .where(
      and(
        eq(mcpOauthRefreshTokens.tenant_id, tenantId),
        eq(mcpOauthRefreshTokens.client_id, clientId),
      ),
    )
    .orderBy(mcpOauthRefreshTokens.id)
    .for("update");
  await exec
    .select({ id: mcpOauthAccessTokens.id })
    .from(mcpOauthAccessTokens)
    .where(
      and(
        eq(mcpOauthAccessTokens.tenant_id, tenantId),
        eq(mcpOauthAccessTokens.client_id, clientId),
      ),
    )
    .orderBy(mcpOauthAccessTokens.id)
    .for("update");

  const access = await exec
    .update(mcpOauthAccessTokens)
    .set({ revoked_at: at })
    .where(
      and(
        eq(mcpOauthAccessTokens.tenant_id, tenantId),
        eq(mcpOauthAccessTokens.client_id, clientId),
        isNull(mcpOauthAccessTokens.revoked_at),
      ),
    )
    .returning({ grant_id: mcpOauthAccessTokens.grant_id });
  const refresh = await exec
    .update(mcpOauthRefreshTokens)
    .set({ revoked_at: at })
    .where(
      and(
        eq(mcpOauthRefreshTokens.tenant_id, tenantId),
        eq(mcpOauthRefreshTokens.client_id, clientId),
        isNull(mcpOauthRefreshTokens.revoked_at),
      ),
    )
    .returning({ grant_id: mcpOauthRefreshTokens.grant_id });
  if ([...access, ...refresh].some((token) => token.grant_id === null)) {
    await exec
      .insert(mcpOauthUnknownGrants)
      .values({ tenant_id: tenantId, client_id: clientId })
      .onConflictDoNothing();
  }
  await exec
    .update(mcpOauthGrants)
    .set({ revoked_at: at })
    .where(
      and(
        eq(mcpOauthGrants.tenant_id, tenantId),
        eq(mcpOauthGrants.client_id, clientId),
        isNull(mcpOauthGrants.revoked_at),
      ),
    );
  return { access_tokens: access.length, refresh_tokens: refresh.length };
}

export async function listTenantClientIds(exec: Executor, tenantId: string): Promise<Set<string>> {
  const [grants, access, refresh] = await Promise.all([
    exec
      .selectDistinct({ client_id: mcpOauthGrants.client_id })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.tenant_id, tenantId)),
    exec
      .selectDistinct({ client_id: mcpOauthAccessTokens.client_id })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.tenant_id, tenantId)),
    exec
      .selectDistinct({ client_id: mcpOauthRefreshTokens.client_id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.tenant_id, tenantId)),
  ]);
  return new Set([...grants, ...access, ...refresh].map((row) => row.client_id));
}
