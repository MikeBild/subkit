import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { Db, Executor } from "../../db/client.ts";
import {
  connectors,
  credentials,
  outboundConnectionStarts,
  outboundConnections,
} from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { invalidateTenantState } from "../../operator/index.ts";
import {
  createSecretVersion,
  readSecretVersion,
  revokeSecretVersion,
} from "../../runtime-config/service.ts";
import { listConnectorRefs } from "../../workflows/connector-refs.ts";
import type { ConnectionAuthorityIdentity } from "../authority-metadata.ts";
import { sameAuthorityScopes } from "../authority-scopes.ts";
import { discoverService, requireConnectable } from "./discovery.ts";
import {
  expiryOf,
  grantedScopes,
  messageOf,
  postTokenEndpoint,
  refreshWasRefused,
  registerClient,
} from "./oauth-client.ts";
import { permissionScopes, requestedScopes } from "./scopes.ts";
import {
  ConnectionError,
  type ConnectionState,
  type ConnectionStateReason,
  type ConnectionSummary,
  type ConnectionUser,
  type ConnectionView,
  type DiscoveryResult,
  type TokenResponse,
} from "./types.ts";

const START_TTL_MS = 10 * 60_000;
export const REFRESH_BUFFER_MS = 5 * 60_000;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

type ConnectionRow = typeof outboundConnections.$inferSelect;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function secretNames(tenantId: string, name: string): { access: string; refresh: string } {
  return {
    access: `connection.${tenantId}.${name}.access_token`,
    refresh: `connection.${tenantId}.${name}.refresh_token`,
  };
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ConnectionError(
      "name_invalid",
      "the name may contain lowercase letters, digits and hyphens, and starts with a letter or digit",
    );
  }
}

export interface StartConnectionInput {
  tenant_id: string;
  user_id: string;
  name: string;
  base_url: string;
  scopes: string[];
  redirect_uri: string;
  client_uri: string | null;
  connection_id?: string;
}

export interface StartConnectionResult {
  authorization_url: string;
  name: string;
  service_name: string | null;
}

export async function startConnection(
  db: Db,
  input: StartConnectionInput,
): Promise<StartConnectionResult> {
  const name = input.name.trim().toLowerCase();
  assertName(name);
  const scopes = permissionScopes(input.scopes);
  if (scopes.length === 0) throw new ConnectionError("scopes_missing", "pick at least one scope");

  let existing: ConnectionRow | null = null;
  if (input.connection_id) {
    existing = await requireConnection(db, input.tenant_id, input.connection_id);
  } else {
    const [taken] = await db
      .select({ id: outboundConnections.id })
      .from(outboundConnections)
      .where(
        and(eq(outboundConnections.tenant_id, input.tenant_id), eq(outboundConnections.name, name)),
      )
      .limit(1);
    if (taken) throw new ConnectionError("name_taken", `a connection named ${name} already exists`);
  }

  const discovery = await discoverService(existing ? existing.base_url : input.base_url);
  const metadata = requireConnectable(discovery);
  const requested = requestedScopes(scopes, metadata);
  const client_id = await registerClient({
    metadata,
    redirectUri: input.redirect_uri,
    clientUri: input.client_uri,
    scopes: requested,
  });

  const code_verifier = base64url(randomBytes(48));
  const code_challenge = createHash("sha256").update(code_verifier).digest("base64url");
  const state = base64url(randomBytes(32));

  await db.insert(outboundConnectionStarts).values({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    state_sha256: sha256(state),
    code_verifier,
    redirect_uri: input.redirect_uri,
    connection_id: existing?.id ?? null,
    name: existing?.name ?? name,
    base_url: discovery.base_url,
    issuer: metadata.issuer,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    registration_endpoint: metadata.registration_endpoint ?? null,
    client_id,
    scopes,
    service_name: discovery.descriptor?.name ?? null,
    service_description: discovery.descriptor?.description ?? null,
    expires_at: new Date(Date.now() + START_TTL_MS),
  });

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client_id);
  url.searchParams.set("redirect_uri", input.redirect_uri);
  url.searchParams.set("scope", requested.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", code_challenge);
  url.searchParams.set("code_challenge_method", "S256");

  logger.info({
    module: "connections",
    action: "connection.start",
    msg: existing ? "renewal started" : "connection started",
    tenant_id: input.tenant_id,
    name: existing?.name ?? name,
    issuer_host: new URL(metadata.issuer).host,
  });

  return {
    authorization_url: url.toString(),
    name: existing?.name ?? name,
    service_name: discovery.descriptor?.name ?? null,
  };
}

async function storeTokens(
  db: Executor,
  args: {
    tenant_id: string;
    name: string;
    token: TokenResponse;
    created_by: string | null;
    previous: { access: number | null; refresh: number | null };
    grant: "authorization_code" | "refresh_token";
  },
): Promise<{ access: number; refresh: number | null }> {
  const names = secretNames(args.tenant_id, args.name);
  const access = await createSecretVersion(db, {
    name: names.access,
    value: args.token.access_token,
    created_by: args.created_by,
  });
  const refresh = args.token.refresh_token
    ? await createSecretVersion(db, {
        name: names.refresh,
        value: args.token.refresh_token,
        created_by: args.created_by,
      })
    : null;
  const retire = async (name: string, version: number | null) => {
    if (version === null) return;
    try {
      await revokeSecretVersion(db, { name, version });
    } catch (error) {
      logger.warn({
        module: "connections",
        action: "connection.previous_version_not_revoked",
        msg: "an older token version stays readable",
        name,
        version,
        error: messageOf(error),
      });
    }
  };
  await retire(names.access, args.previous.access);
  const keepPrevious = !refresh && args.grant === "refresh_token";
  if (!keepPrevious) await retire(names.refresh, args.previous.refresh);
  return {
    access: access.version,
    refresh: refresh?.version ?? (keepPrevious ? args.previous.refresh : null),
  };
}

export type CompleteConnectionResult =
  | { ok: true; tenant_id: string; name: string; connection_id: string; renewed: boolean }
  | {
      ok: false;
      tenant_id: string | null;
      connection_id: string | null;
      name: string | null;
      code: ConnectionError["code"];
      message: string;
    };

export async function completeConnection(
  db: Db,
  input: { state: string; code?: string | undefined; error?: string | undefined },
): Promise<CompleteConnectionResult> {
  const now = new Date();
  const [start] = await db
    .update(outboundConnectionStarts)
    .set({ consumed_at: now })
    .where(
      and(
        eq(outboundConnectionStarts.state_sha256, sha256(input.state)),
        isNull(outboundConnectionStarts.consumed_at),
        gt(outboundConnectionStarts.expires_at, now),
      ),
    )
    .returning();
  if (!start) {
    return {
      ok: false,
      tenant_id: null,
      connection_id: null,
      name: null,
      code: "state_invalid",
      message: "this connection attempt expired or was already used",
    };
  }

  const fail = async (code: ConnectionError["code"], message: string) => {
    await auditAwait(
      {
        tenant_id: start.tenant_id,
        actor_type: "user",
        actor_id: start.user_id,
        action: AuditAction.CONNECTION_FAILED,
        resource_type: "connection",
        resource_id: start.connection_id,
        result: code === "denied" ? "denied" : "error",
        reason: code,
        metadata: { name: start.name, issuer_host: new URL(start.issuer).host, message },
      },
      db,
    );
    return {
      ok: false as const,
      tenant_id: start.tenant_id,
      connection_id: start.connection_id,
      name: start.name,
      code,
      message,
    };
  };

  if (input.error || !input.code) {
    return fail("denied", input.error ?? "the other side sent no code");
  }

  let token: TokenResponse;
  try {
    token = await postTokenEndpoint(
      start.token_endpoint,
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: start.redirect_uri,
        client_id: start.client_id,
        code_verifier: start.code_verifier,
      },
      "token_exchange_failed",
    );
  } catch (error) {
    return fail("token_exchange_failed", messageOf(error));
  }
  if (!token.refresh_token) {
    logger.warn({
      module: "connections",
      action: "connection.no_refresh_token",
      msg: "the token endpoint issued no refresh token; the connection will not renew itself",
      tenant_id: start.tenant_id,
      name: start.name,
      issuer_host: new URL(start.issuer).host,
      expires_at: expiryOf(token)?.toISOString() ?? null,
    });
  }

  const connectionId = await db.transaction(async (tx) => {
    const [existing] = start.connection_id
      ? await tx
          .select()
          .from(outboundConnections)
          .where(
            and(
              eq(outboundConnections.tenant_id, start.tenant_id),
              eq(outboundConnections.id, start.connection_id),
            ),
          )
          .for("update")
      : [];
    if (start.connection_id && !existing)
      throw new ConnectionError("not_found", "connection was removed during authorization");
    const versions = await storeTokens(tx, {
      tenant_id: start.tenant_id,
      name: start.name,
      token,
      created_by: start.user_id,
      previous: {
        access: existing?.access_token_version ?? null,
        refresh: existing?.refresh_token_version ?? null,
      },
      grant: "authorization_code",
    });

    const shared = {
      base_url: start.base_url,
      issuer: start.issuer,
      authorization_endpoint: start.authorization_endpoint,
      token_endpoint: start.token_endpoint,
      registration_endpoint: start.registration_endpoint,
      client_id: start.client_id,
      scopes: start.scopes,
      granted_scopes: grantedScopes(token),
      service_name: start.service_name,
      service_description: start.service_description,
      access_token_version: versions.access,
      refresh_token_version: versions.refresh,
      expires_at: expiryOf(token),
      last_refreshed_at: now,
      refresh_failed_at: null,
      last_error: null,
      updated_at: now,
    };

    let connectionId: string;
    if (existing) {
      const [updated] = await tx
        .update(outboundConnections)
        .set({ ...shared, authority_revision: sql`${outboundConnections.authority_revision} + 1` })
        .where(
          and(
            eq(outboundConnections.id, existing.id),
            eq(outboundConnections.tenant_id, start.tenant_id),
          ),
        )
        .returning({ id: outboundConnections.id });
      if (!updated)
        throw new ConnectionError("not_found", "connection was removed during authorization");
      connectionId = existing.id;
    } else {
      const [created] = await tx
        .insert(outboundConnections)
        .values({
          tenant_id: start.tenant_id,
          name: start.name,
          created_by: start.user_id,
          ...shared,
        })
        .returning({ id: outboundConnections.id });
      if (!created) throw new Error("outbound connection insert returned no row");
      connectionId = created.id;
    }

    await auditAwait(
      {
        tenant_id: start.tenant_id,
        actor_type: "user",
        actor_id: start.user_id,
        action: existing ? AuditAction.CONNECTION_RENEWED : AuditAction.CONNECTION_CREATED,
        resource_type: "connection",
        resource_id: connectionId,
        result: "success",
        metadata: {
          name: start.name,
          issuer_host: new URL(start.issuer).host,
          scopes: start.scopes,
          granted_scopes: grantedScopes(token),
          expires_at: expiryOf(token)?.toISOString() ?? null,
          auto_renew: versions.refresh !== null,
        },
      },
      tx,
    );

    return connectionId;
  });
  invalidateTenantState(start.tenant_id);

  return {
    ok: true,
    tenant_id: start.tenant_id,
    name: start.name,
    connection_id: connectionId,
    renewed: Boolean(start.connection_id),
  };
}

export async function connectorsUsingConnection(
  db: Db,
  tenantId: string,
  connectionId: string,
): Promise<string[]> {
  const users = await usersOfConnections(db, tenantId, [connectionId]);
  return (users.get(connectionId) ?? []).map((user) => user.connector_id);
}

async function findConnection(db: Db, tenantId: string, id: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(outboundConnections)
    .where(and(eq(outboundConnections.tenant_id, tenantId), eq(outboundConnections.id, id)))
    .limit(1);
  return row ?? null;
}

async function requireConnection(db: Db, tenantId: string, id: string): Promise<ConnectionRow> {
  const row = await findConnection(db, tenantId, id);
  if (!row) throw new ConnectionError("not_found", "connection not found");
  return row;
}

async function currentAccessToken(db: Db, row: ConnectionRow): Promise<string | null> {
  try {
    return await readSecretVersion(
      db,
      secretNames(row.tenant_id, row.name).access,
      row.access_token_version,
    );
  } catch {
    return null;
  }
}

export function connectionStateOf(
  row: Pick<
    ConnectionRow,
    "refresh_failed_at" | "expires_at" | "refresh_token_version" | "last_error"
  >,
  readable: boolean,
  nowMs: number,
): { state: ConnectionState; state_reason: ConnectionStateReason | null } {
  if (!readable) return { state: "unreadable", state_reason: "secret_unreadable" };
  if (row.refresh_failed_at)
    return {
      state: "expired",
      state_reason: refreshWasRefused(row.last_error) ? "refresh_refused" : "refresh_failed",
    };
  const expiresMs = row.expires_at?.getTime() ?? null;
  if (row.refresh_token_version === null) {
    if (expiresMs !== null && expiresMs <= nowMs)
      return { state: "expired", state_reason: "expired_no_refresh" };
    if (expiresMs !== null) return { state: "expiring", state_reason: null };
  }
  return { state: "valid", state_reason: null };
}

function toView(
  row: ConnectionRow,
  readable: boolean,
  usedBy: ConnectionUser[],
  nowMs: number,
): ConnectionView {
  const { state, state_reason } = connectionStateOf(row, readable, nowMs);
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    issuer: row.issuer,
    service_name: row.service_name,
    service_description: row.service_description,
    scopes: permissionScopes(row.scopes),
    granted_scopes: row.granted_scopes ? permissionScopes(row.granted_scopes) : null,
    state,
    state_reason,
    auto_renew: row.refresh_token_version !== null,
    expires_at: row.expires_at?.toISOString() ?? null,
    last_used_at: row.last_used_at?.toISOString() ?? null,
    last_refreshed_at: row.last_refreshed_at?.toISOString() ?? null,
    refresh_failed_at: row.refresh_failed_at?.toISOString() ?? null,
    last_error: row.last_error,
    used_by: usedBy,
    created_at: row.created_at.toISOString(),
  };
}

async function usersOfConnections(
  db: Db,
  tenantId: string,
  connectionIds: readonly string[],
): Promise<Map<string, ConnectionUser[]>> {
  const out = new Map<string, ConnectionUser[]>();
  if (connectionIds.length === 0) return out;
  const rows = await db
    .selectDistinct({
      connection_id: credentials.connection_id,
      connector_id: connectors.id,
      slug: connectors.slug,
      display_name: connectors.display_name,
    })
    .from(credentials)
    .innerJoin(
      connectors,
      and(eq(connectors.id, credentials.connector_id), eq(connectors.tenant_id, tenantId)),
    )
    .where(
      and(
        eq(credentials.tenant_id, tenantId),
        inArray(credentials.connection_id, [...connectionIds]),
        isNull(credentials.deleted_at),
        isNull(connectors.deleted_at),
      ),
    )
    .orderBy(asc(connectors.display_name), asc(connectors.slug));
  if (rows.length === 0) return out;
  const workflowsBySlug = new Map<string, number>();
  for (const slugs of (await listConnectorRefs(tenantId, db)).values()) {
    for (const slug of slugs) workflowsBySlug.set(slug, (workflowsBySlug.get(slug) ?? 0) + 1);
  }
  for (const row of rows) {
    if (!row.connection_id) continue;
    const list = out.get(row.connection_id) ?? [];
    list.push({
      connector_id: row.connector_id,
      slug: row.slug,
      display_name: row.display_name,
      workflow_count: workflowsBySlug.get(row.slug) ?? 0,
    });
    out.set(row.connection_id, list);
  }
  return out;
}

export async function listConnections(db: Db, tenantId: string): Promise<ConnectionView[]> {
  const rows = await db
    .select()
    .from(outboundConnections)
    .where(eq(outboundConnections.tenant_id, tenantId))
    .orderBy(outboundConnections.name);
  const usedBy = await usersOfConnections(
    db,
    tenantId,
    rows.map((row) => row.id),
  );
  const nowMs = Date.now();
  const views: ConnectionView[] = [];
  for (const row of rows) {
    const readable = (await currentAccessToken(db, row)) !== null;
    views.push(toView(row, readable, usedBy.get(row.id) ?? [], nowMs));
  }
  return views;
}

export async function getConnection(db: Db, tenantId: string, id: string): Promise<ConnectionView> {
  const row = await requireConnection(db, tenantId, id);
  const readable = (await currentAccessToken(db, row)) !== null;
  const usedBy = await usersOfConnections(db, tenantId, [row.id]);
  return toView(row, readable, usedBy.get(row.id) ?? [], Date.now());
}

export async function summarizeConnections(
  db: Db,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, ConnectionSummary>> {
  const out = new Map<string, ConnectionSummary>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const rows = await db
    .select()
    .from(outboundConnections)
    .where(
      and(eq(outboundConnections.tenant_id, tenantId), inArray(outboundConnections.id, unique)),
    );
  const nowMs = Date.now();
  for (const row of rows) {
    const readable = (await currentAccessToken(db, row)) !== null;
    out.set(row.id, {
      id: row.id,
      name: row.name,
      state: connectionStateOf(row, readable, nowMs).state,
    });
  }
  return out;
}

async function refreshRow(
  db: Db,
  row: ConnectionRow,
  actorId: string | null,
): Promise<ConnectionRow> {
  const names = secretNames(row.tenant_id, row.name);
  if (row.refresh_token_version === null) {
    throw new ConnectionError("refresh_failed", "no refresh token; renew the connection");
  }
  try {
    const refreshToken = await readSecretVersion(db, names.refresh, row.refresh_token_version);
    const token = await postTokenEndpoint(
      row.token_endpoint,
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: row.client_id },
      "refresh_failed",
    );
    const now = new Date();
    const nextScopes = grantedScopes(token) ?? row.granted_scopes;
    const authorityChanged = !sameAuthorityScopes(
      row.granted_scopes?.join(" ") ?? null,
      nextScopes?.join(" ") ?? null,
    );
    const refreshed = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: outboundConnections.id })
        .from(outboundConnections)
        .where(
          and(
            eq(outboundConnections.id, row.id),
            eq(outboundConnections.tenant_id, row.tenant_id),
            eq(outboundConnections.authority_revision, row.authority_revision),
            eq(outboundConnections.access_token_version, row.access_token_version),
          ),
        )
        .for("update");
      if (!current)
        throw new ConnectionError("refresh_failed", "connection changed during refresh");
      const versions = await storeTokens(tx, {
        tenant_id: row.tenant_id,
        name: row.name,
        token,
        created_by: actorId,
        previous: { access: row.access_token_version, refresh: row.refresh_token_version },
        grant: "refresh_token",
      });
      const [updated] = await tx
        .update(outboundConnections)
        .set({
          access_token_version: versions.access,
          refresh_token_version: versions.refresh,
          expires_at: expiryOf(token),
          granted_scopes: nextScopes,
          authority_revision: row.authority_revision + (authorityChanged ? 1 : 0),
          last_refreshed_at: now,
          refresh_failed_at: null,
          last_error: null,
          updated_at: now,
        })
        .where(
          and(
            eq(outboundConnections.id, row.id),
            eq(outboundConnections.tenant_id, row.tenant_id),
            eq(outboundConnections.authority_revision, row.authority_revision),
            eq(outboundConnections.access_token_version, row.access_token_version),
          ),
        )
        .returning();
      if (!updated)
        throw new ConnectionError("refresh_failed", "connection changed during refresh");
      await auditAwait(
        {
          tenant_id: row.tenant_id,
          actor_type: actorId ? "user" : "system",
          actor_id: actorId,
          action: AuditAction.CONNECTION_REFRESHED,
          resource_type: "connection",
          resource_id: row.id,
          result: "success",
          metadata: {
            name: row.name,
            expires_at: expiryOf(token)?.toISOString() ?? null,
            authority_changed: authorityChanged,
          },
        },
        tx,
      );
      return updated;
    });
    invalidateTenantState(row.tenant_id);
    return refreshed;
  } catch (error) {
    const message = messageOf(error);
    await db
      .update(outboundConnections)
      .set({ refresh_failed_at: new Date(), last_error: message, updated_at: new Date() })
      .where(
        and(
          eq(outboundConnections.id, row.id),
          eq(outboundConnections.tenant_id, row.tenant_id),
          eq(outboundConnections.authority_revision, row.authority_revision),
          eq(outboundConnections.access_token_version, row.access_token_version),
        ),
      );
    invalidateTenantState(row.tenant_id);
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: actorId ? "user" : "system",
        actor_id: actorId,
        action: AuditAction.CONNECTION_REFRESH_FAILED,
        resource_type: "connection",
        resource_id: row.id,
        result: "error",
        reason: "refresh_failed",
        metadata: { name: row.name, message },
      },
      db,
    );
    throw error instanceof ConnectionError ? error : new ConnectionError("refresh_failed", message);
  }
}

function needsRefresh(row: ConnectionRow, nowMs: number): boolean {
  if (row.refresh_token_version === null || row.refresh_failed_at) return false;
  if (!row.expires_at) return false;
  return row.expires_at.getTime() - nowMs <= REFRESH_BUFFER_MS;
}

export async function readAccessToken(
  db: Db,
  tenantId: string,
  connectionId: string,
): Promise<{
  access_token: string;
  expires_at: Date | null;
  connection_authority: ConnectionAuthorityIdentity;
} | null> {
  let row = await findConnection(db, tenantId, connectionId);
  if (!row) return null;
  const nowMs = Date.now();
  if (needsRefresh(row, nowMs)) {
    try {
      row = await refreshRow(db, row, null);
    } catch {
      return null;
    }
  } else if (row.expires_at && row.expires_at.getTime() <= nowMs) {
    return null;
  }
  const access_token = await currentAccessToken(db, row);
  if (!access_token) return null;
  if (!row.last_used_at || nowMs - row.last_used_at.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await db
      .update(outboundConnections)
      .set({ last_used_at: new Date(nowMs) })
      .where(and(eq(outboundConnections.id, row.id), eq(outboundConnections.tenant_id, tenantId)));
  }
  return {
    access_token,
    expires_at: row.expires_at,
    connection_authority: { id: row.id, revision: row.authority_revision },
  };
}

export async function refreshDueConnections(
  db: Db,
  now: Date = new Date(),
): Promise<{ refreshed: number; failed: number }> {
  // tenant-filter:exempt — the sweep spans every tenant on purpose; each row carries its own.
  const due = await db
    .select()
    .from(outboundConnections)
    .where(
      and(
        lte(outboundConnections.expires_at, new Date(now.getTime() + REFRESH_BUFFER_MS)),
        isNull(outboundConnections.refresh_failed_at),
        sql`${outboundConnections.refresh_token_version} is not null`,
      ),
    );
  let refreshed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      await refreshRow(db, row, null);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }
  return { refreshed, failed };
}

export async function disconnectConnection(
  db: Db,
  args: { tenant_id: string; id: string; actor_id: string | null },
): Promise<{ name: string }> {
  const row = await requireConnection(db, args.tenant_id, args.id);
  const names = secretNames(row.tenant_id, row.name);
  for (const [name, version] of [
    [names.access, row.access_token_version],
    [names.refresh, row.refresh_token_version],
  ] as const) {
    if (version === null) continue;
    try {
      await revokeSecretVersion(db, { name, version });
    } catch (error) {
      logger.warn({
        module: "connections",
        action: "connection.version_not_revoked",
        msg: "a token version could not be revoked while disconnecting",
        name,
        version,
        error: messageOf(error),
      });
    }
  }
  const [usage] = await db
    .select({ n: count() })
    .from(credentials)
    .where(and(eq(credentials.tenant_id, args.tenant_id), eq(credentials.connection_id, row.id)));
  await db
    .delete(outboundConnections)
    .where(
      and(eq(outboundConnections.id, row.id), eq(outboundConnections.tenant_id, args.tenant_id)),
    );
  invalidateTenantState(args.tenant_id);
  await auditAwait(
    {
      tenant_id: args.tenant_id,
      actor_type: args.actor_id ? "user" : "system",
      actor_id: args.actor_id,
      action: AuditAction.CONNECTION_DISCONNECTED,
      resource_type: "connection",
      resource_id: row.id,
      result: "success",
      metadata: { name: row.name, used_by_connectors: Number(usage?.n ?? 0) },
    },
    db,
  );
  return { name: row.name };
}

export type { DiscoveryResult };
