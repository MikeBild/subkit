// External MCP server registry — tenant-scoped CRUD over `mcp_servers`.
//
// This is the inverse direction from subkit's own MCP server: tenants
// register external MCP servers (whose tools the conversation loop's LLM
// can invoke). Every row is owned by exactly one tenant and EVERY query
// here carries `tenant_id` in its WHERE clause — non-negotiable. A bug
// that drops the tenant predicate would let one workspace read or mutate
// another's outbound MCP targets, so the predicate is repeated at every
// call site rather than hidden behind a helper that could be bypassed.
//
// Secret material never lives in this table: `auth_config` carries ONLY
// the non-secret shape (`kind` + oauth2 issuer/client_id/scope), enforced
// by the `mcp_servers_auth_config_no_inline_secrets_check` DB constraint.
// The actual bearer/oauth2 secret lives encrypted in `credentials` keyed
// by `mcp_server_id`; the client pool (pool.ts) resolves it at handshake
// via `getCredentialForMcpServer`.

import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { mcpNamespaceSchema } from "../../api/common-schemas.ts";
import { recordMcpServerConfigUpdated } from "../../audit/recorders/index.ts";
import {
  recordMcpServerDeleted,
  recordMcpServerDisabled,
  recordMcpServerErrored,
  recordMcpServerReEnabled,
  recordMcpServerRegistered,
} from "../../audit/recorders/mcp-server.ts";
import type { RecorderBase } from "../../audit/recorders/types.ts";
import { assertEgressAllowed } from "../../connectors/egress-guard.ts";
import type { Db } from "../../db/client.ts";
import { mcpServers } from "../../db/schema/index.ts";
import type { McpServerStatus, McpServerTransport } from "../../db/schema/mcp_servers.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";

/** Drizzle executor — a `Db` or an open transaction. */
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The single environment every MCP-server credential is written under and
 * resolved from. `mcp_servers` rows carry no per-server environment, so
 * the writer (routes / OAuth callback) and the reader (the client pool's
 * handshake) MUST share this constant — a writer/reader mismatch would
 * store a secret the pool can never find.
 */
export const MCP_CREDENTIAL_ENVIRONMENT = "prod" as const;

/** Row mirror of `mcpServers.$inferSelect`. Re-exported so the loop +
 *  route layers don't have to reach into the schema module. */
export type McpServerRow = typeof mcpServers.$inferSelect;

/**
 * Non-secret auth shape persisted in `mcp_servers.auth_config`. Carries
 * ONLY the `kind` discriminator plus the non-secret oauth2 parameters.
 * The actual bearer token / OAuth refresh+access token is resolved from
 * the AES-256-GCM `credentials` table (keyed by `mcp_server_id`) by the
 * client pool at handshake time. NEVER inline a secret here — the DB
 * CHECK rejects it.
 */
export interface McpServerAuthConfig {
  kind: "none" | "bearer" | "oauth2";
  /** OAuth2 issuer base URL (oauth2 only). */
  issuer?: string;
  /** OAuth2 client id (oauth2 only; absent → dynamic registration path). */
  client_id?: string;
  /** OAuth2 scope string (oauth2 only). */
  scope?: string;
}

/**
 * Audit envelope every mutating function threads through to the recorder.
 *
 * `executor` is ASYMMETRIC BY DESIGN: the route layer always threads the
 * request-scoped db (or its open transaction) so audit rows land on the
 * same pool/tx the route already uses — required for atomic commit with
 * the domain write and for integration-test isolation. The boot
 * config-seed path (`config-seed.ts`) intentionally OMITS it: boot
 * reconciliation is non-transactional, and `auditAwait` then falls back
 * to `getDb()`. Do not "fix" a missing executor on the seed path.
 */
export interface McpServerAuditCtx {
  actor_id: string | null;
  request_source: RequestSource;
  executor?: Executor;
}

export interface CreateMcpServerInput {
  tenant_id: string;
  name: string;
  namespace: string;
  transport: McpServerTransport;
  url: string;
  auth_config?: McpServerAuthConfig;
}

export interface UpdateMcpServerPatch {
  name?: string;
  namespace?: string;
  transport?: McpServerTransport;
  url?: string;
  auth_config?: McpServerAuthConfig | null;
}

// Namespace constraint mirrors the DB CHECK on `mcp_servers.namespace`
// EXACTLY (`^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$` plus a `__`-run
// ban). Imported from the shared single source of truth in
// `api/common-schemas.ts` so the route / registry / config decls can never
// drift apart.
const namespaceSchema = mcpNamespaceSchema;

// `auth_config` is the NON-SECRET shape only. The bearer/oauth2 secret
// lives in `credentials` keyed by `mcp_server_id` — never on this row.
// `.strict()` rejects any stray key (including a leaked secret) at the
// boundary so a bad writer fails Zod validation, not the DB CHECK.
const authConfigSchema = z
  .object({
    kind: z.enum(["none", "bearer", "oauth2"]),
    issuer: z.string().url().optional(),
    client_id: z.string().optional(),
    scope: z.string().optional(),
  })
  .strict();

// Build the shared audit base, omitting `executor` entirely when absent so
// `exactOptionalPropertyTypes` is satisfied (passing `executor: undefined`
// is a type error under that flag).
// Shared base every recorder call carries. Typed off the recorder's own
// `RecorderBase` so the optional `executor` property's identity matches
// exactly and `exactOptionalPropertyTypes` is satisfied when this object
// is spread into a recorder param.
type RecorderEnvelope = RecorderBase & { request_source: RequestSource };

function auditBase(tenant_id: string, auditCtx: McpServerAuditCtx): RecorderEnvelope {
  const base: RecorderEnvelope = {
    tenant_id,
    actor_id: auditCtx.actor_id,
    request_source: auditCtx.request_source,
  };
  // Assign the key only when present so `exactOptionalPropertyTypes` never
  // sees `executor: undefined`.
  if (auditCtx.executor) base.executor = auditCtx.executor;
  return base;
}

const createInputSchema = z.object({
  tenant_id: z.string().min(1),
  name: z.string().min(1),
  namespace: namespaceSchema,
  transport: z.enum(["http", "sse", "stdio"]),
  url: z.string().url(),
  auth_config: authConfigSchema.optional(),
});

const updatePatchSchema = z.object({
  name: z.string().min(1).optional(),
  namespace: namespaceSchema.optional(),
  transport: z.enum(["http", "sse", "stdio"]).optional(),
  url: z.string().url().optional(),
  auth_config: authConfigSchema.nullable().optional(),
});

function urlHost(url: string): string {
  return new URL(url).host;
}

// Match any http(s) URL embedded in a raw transport/fetch error so it can
// be reduced to host-only before the message is persisted in `last_error`.
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>)]+/gi;
// Coarse cap so a verbose remote error body can't bloat the row.
const MAX_LAST_ERROR_CHARS = 300;

/**
 * Sanitize a raw transport/fetch error before persisting it in
 * `last_error`. Raw errors frequently embed the full request URL (with
 * its query string) or echoed auth material. Every embedded URL is
 * reduced to `scheme://host` (path + query stripped, same host-only
 * reduction `urlHost` applies for audit), and the result is length-capped.
 * NEVER persist a query string or token.
 */
export function redactLastError(message: string): string {
  const sanitized = message.replace(URL_IN_TEXT_RE, (match) => {
    try {
      const u = new URL(match);
      return `${u.protocol}//${u.host}`;
    } catch {
      return "[url]";
    }
  });
  return sanitized.length > MAX_LAST_ERROR_CHARS
    ? `${sanitized.slice(0, MAX_LAST_ERROR_CHARS)}…`
    : sanitized;
}

/** INSERT a new external MCP server + audit. Validates input via Zod so a
 *  malformed namespace / url is a 422-able error, not a 500. */
export async function createMcpServer(
  db: Executor,
  input: CreateMcpServerInput,
  auditCtx: McpServerAuditCtx,
): Promise<McpServerRow> {
  const parsed = createInputSchema.parse(input);
  // SSRF guard at registration: reject a loopback/link-local/RFC1918/
  // metadata target up front so a bad URL fails as a 422-able boundary
  // error here, not only later at connect time. The same guard runs again
  // in the pool before each handshake. `EgressBlockedError` carries the
  // host (not the full URL) so it is safe to surface.
  assertEgressAllowed(parsed.url, { tenant_id: parsed.tenant_id });
  const [row] = await db
    .insert(mcpServers)
    .values({
      tenant_id: parsed.tenant_id,
      name: parsed.name,
      namespace: parsed.namespace,
      transport: parsed.transport,
      url: parsed.url,
      auth_config: (parsed.auth_config ?? null) as Record<string, unknown> | null,
      status: "active",
    })
    .returning();
  if (!row) throw new Error("createMcpServer: insert returned no row");

  await recordMcpServerRegistered({
    ...auditBase(parsed.tenant_id, auditCtx),
    mcp_server_id: row.id,
    namespace: row.namespace,
    transport: row.transport,
    url_host: urlHost(parsed.url),
  });
  return row;
}

export async function listMcpServers(db: Executor, tenant_id: string): Promise<McpServerRow[]> {
  return db.select().from(mcpServers).where(eq(mcpServers.tenant_id, tenant_id));
}

export async function getMcpServer(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<McpServerRow | null> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMcpServerByNamespace(
  db: Executor,
  tenant_id: string,
  namespace: string,
): Promise<McpServerRow | null> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.namespace, namespace)))
    .limit(1);
  return rows[0] ?? null;
}

/** UPDATE config fields + audit with the computed `changed_fields`. */
export async function updateMcpServer(
  db: Executor,
  tenant_id: string,
  id: string,
  patch: UpdateMcpServerPatch,
  auditCtx: McpServerAuditCtx,
): Promise<McpServerRow | null> {
  const parsed = updatePatchSchema.parse(patch);
  // SSRF guard: a URL change must clear the egress policy before it is
  // persisted, so an operator can't repoint a server at an internal host.
  if (parsed.url !== undefined) {
    assertEgressAllowed(parsed.url, { tenant_id });
  }
  const existing = await getMcpServer(db, tenant_id, id);
  if (!existing) return null;

  const set: Partial<typeof mcpServers.$inferInsert> = {};
  const changed_fields: string[] = [];
  if (parsed.name !== undefined && parsed.name !== existing.name) {
    set.name = parsed.name;
    changed_fields.push("name");
  }
  if (parsed.namespace !== undefined && parsed.namespace !== existing.namespace) {
    set.namespace = parsed.namespace;
    changed_fields.push("namespace");
  }
  if (parsed.transport !== undefined && parsed.transport !== existing.transport) {
    set.transport = parsed.transport;
    changed_fields.push("transport");
  }
  if (parsed.url !== undefined && parsed.url !== existing.url) {
    set.url = parsed.url;
    changed_fields.push("url");
  }
  if (parsed.auth_config !== undefined) {
    set.auth_config = (parsed.auth_config ?? null) as Record<string, unknown> | null;
    changed_fields.push("auth_config");
  }

  if (changed_fields.length === 0) return existing;

  set.updated_at = new Date();
  const [row] = await db
    .update(mcpServers)
    .set(set)
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.id, id)))
    .returning();
  if (!row) return null;

  await recordMcpServerConfigUpdated({
    ...auditBase(tenant_id, auditCtx),
    mcp_server_id: id,
    namespace: row.namespace,
    changed_fields,
  });
  return row;
}

/**
 * Flip a server's status and land the matching audit row:
 *   active   → disabled : recordMcpServerDisabled
 *   disabled → active   : recordMcpServerReEnabled
 *   * → error           : recordMcpServerErrored (last_error required)
 * Also persists `last_error` / `last_handshake_at` side effects when
 * relevant. The pool calls this on handshake failure (error) and the
 * route/CLI layers call it on operator-driven enable/disable.
 */
export async function setMcpServerStatus(
  db: Executor,
  tenant_id: string,
  id: string,
  status: McpServerStatus,
  auditCtx: McpServerAuditCtx,
  opts?: { last_error?: string; reason?: string },
): Promise<McpServerRow | null> {
  const existing = await getMcpServer(db, tenant_id, id);
  if (!existing) return null;

  // Redact any URL/query/token embedded in the raw error before it is
  // persisted or audited (secret-by-reference: the row + audit trail
  // must never carry a query string or echoed auth material).
  const safeError = redactLastError(opts?.last_error ?? "unknown error");
  const set: Partial<typeof mcpServers.$inferInsert> = {
    status,
    updated_at: new Date(),
  };
  if (status === "error") {
    set.last_error = safeError;
  } else {
    // Clear a stale error when the server recovers to active/disabled.
    set.last_error = null;
  }
  const [row] = await db
    .update(mcpServers)
    .set(set)
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.id, id)))
    .returning();
  if (!row) return null;

  if (status === "error") {
    await recordMcpServerErrored({
      ...auditBase(tenant_id, auditCtx),
      mcp_server_id: id,
      namespace: row.namespace,
      last_error: safeError,
    });
  } else if (status === "disabled" && existing.status !== "disabled") {
    await recordMcpServerDisabled({
      ...auditBase(tenant_id, auditCtx),
      mcp_server_id: id,
      namespace: row.namespace,
      ...(opts?.reason ? { reason: opts.reason } : {}),
    });
  } else if (status === "active" && existing.status !== "active") {
    await recordMcpServerReEnabled({
      ...auditBase(tenant_id, auditCtx),
      mcp_server_id: id,
      namespace: row.namespace,
      ...(opts?.reason ? { reason: opts.reason } : {}),
    });
  }
  return row;
}

/**
 * Record a successful handshake: bump `last_handshake_at`, clear
 * `last_error`, and persist the observed `tools_manifest_hash`. The
 * handshake-ok audit row is emitted by the pool (which holds the
 * tool_count); this function only writes the durable row state.
 *
 * AUTO-RECOVERY AUDIT: a successful handshake recovers a server that was
 * parked in `error` back to `active` via the direct UPDATE below. That
 * status flip is an operator-visible state change, so when the PRIOR status
 * was `error` we ALSO emit `mcp_server.re_enabled` (reason
 * `auto_recovered_via_handshake`) — the same row a manual enable lands —
 * so the auto-recovery edge isn't a silent UPDATE with no trail. The prior
 * status is read off the existing row BEFORE the UPDATE.
 *
 * SOLE-WRITER CONTRACT (`tools_manifest_hash`): observed-handshake state is
 * the ONLY legitimate origin of this column — this function (every
 * successful handshake) and the schema-drift reconciler
 * (`schema-drift.ts reconcileManifestHash`, which persists the drifted hash
 * it just observed). `updatePatchSchema` / `updateMcpServer` deliberately
 * EXCLUDE it: the operator PATCH surface must never write the hash, so a
 * `mcp_server.config_updated` audit row whose `changed_fields` is exactly
 * `["tools_manifest_hash"]` can ONLY mean drift — the SIEM discriminator
 * documented on `RecordMcpServerConfigUpdatedParams` depends on that.
 */
export async function recordMcpServerHandshakeState(
  db: Executor,
  tenant_id: string,
  id: string,
  tools_manifest_hash: string,
  auditCtx: McpServerAuditCtx,
): Promise<McpServerRow | null> {
  const existing = await getMcpServer(db, tenant_id, id);
  const [row] = await db
    .update(mcpServers)
    .set({
      last_handshake_at: new Date(),
      last_error: null,
      // A successful handshake means the server is reachable; if it was
      // parked in `error` from a prior failure, recover it to active.
      status: "active",
      tools_manifest_hash,
      updated_at: new Date(),
    })
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.id, id)))
    .returning();
  if (!row) return null;

  // The handshake recovered an errored server to active — audit the edge
  // exactly as a manual enable would, so the auto-recovery is queryable.
  if (existing?.status === "error") {
    await recordMcpServerReEnabled({
      ...auditBase(tenant_id, auditCtx),
      mcp_server_id: id,
      namespace: row.namespace,
      reason: "auto_recovered_via_handshake",
    });
  }
  return row;
}

export async function deleteMcpServer(
  db: Executor,
  tenant_id: string,
  id: string,
  auditCtx: McpServerAuditCtx,
): Promise<boolean> {
  const existing = await getMcpServer(db, tenant_id, id);
  if (!existing) return false;

  await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.id, id)));

  await recordMcpServerDeleted({
    ...auditBase(tenant_id, auditCtx),
    mcp_server_id: id,
    namespace: existing.namespace,
  });
  return true;
}

/** Active servers for a tenant — consumed by the loop layer to assemble
 *  the merged tool palette. */
export async function listActiveMcpServersForTenant(
  db: Executor,
  tenant_id: string,
): Promise<McpServerRow[]> {
  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.status, "active")));
}

/**
 * Connectable servers for a tenant: every row whose status is NOT
 * `disabled` (i.e. `active` OR `error`). A transient handshake failure
 * flips a server to `error`; excluding those forever (as a plain
 * `status = 'active'` filter does) leaves the server permanently dark
 * even after the remote recovers. The pool includes `error` rows here
 * and gates them on its in-memory exponential backoff window, so a
 * recovered server is retried once its backoff has elapsed and a
 * successful handshake recovers it to `active`. `disabled` is an
 * operator decision and is never auto-retried.
 */
export async function listConnectableMcpServersForTenant(
  db: Executor,
  tenant_id: string,
): Promise<McpServerRow[]> {
  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.tenant_id, tenant_id), ne(mcpServers.status, "disabled")));
}

/** Parse an arbitrary `auth_config` jsonb blob into the typed shape.
 *  Returns the `none` default when the column is null. Used by the pool. */
export function parseAuthConfig(raw: Record<string, unknown> | null): McpServerAuthConfig {
  if (!raw) return { kind: "none" };
  const parsed = authConfigSchema.parse(raw);
  // Drop keys whose value is `undefined` so the result structurally
  // matches `McpServerAuthConfig` under `exactOptionalPropertyTypes`.
  const out: McpServerAuthConfig = { kind: parsed.kind };
  if (parsed.issuer !== undefined) out.issuer = parsed.issuer;
  if (parsed.client_id !== undefined) out.client_id = parsed.client_id;
  if (parsed.scope !== undefined) out.scope = parsed.scope;
  return out;
}
