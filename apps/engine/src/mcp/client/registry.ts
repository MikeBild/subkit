// External MCP servers, as seen by the client pool.
//
// An external MCP server IS a connector: one row in `connectors` whose
// driver is `mcp`, its endpoint in `base_url`, its transport and
// non-secret auth shape under `config.mcp`, and its negotiated session
// state in the 1:1 `connector_mcp_sessions` extension table. There is no
// second registry — this module is the MCP-shaped READ over the connector
// row plus the two writes only a handshake may perform.
//
// Every query here carries `tenant_id` in its WHERE clause — non-negotiable.
// A bug that drops the tenant predicate would let one workspace read or
// mutate another's outbound MCP targets, so the predicate is repeated at
// every call site rather than hidden behind a helper that could be bypassed.
//
// Secret material never lives on the connector row: `config.mcp.auth`
// carries ONLY the non-secret shape (`kind` + oauth2 issuer/client_id/
// scope), enforced by the `connectors_mcp_auth_no_inline_secrets_check` DB
// constraint. The actual bearer/oauth2 secret lives encrypted in
// `credentials` keyed by `connector_id`; `session-auth.ts` resolves it at
// handshake time.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { scrubString } from "@shared/index.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordConnectorMcpClientRegistered } from "../../audit/recorders/index.ts";
import { EgressBlockedError } from "../../connectors/egress-guard.ts";
import { setConnectorHealth } from "../../connectors/health-state.ts";
import type { Db, Executor } from "../../db/client.ts";
import { connectorMcpSessions, connectors } from "../../db/schema/index.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";

/**
 * The single environment every MCP credential is written under and
 * resolved from. An `mcp` connector row does carry an `environment`, but
 * the writer (the credential-setup / OAuth routes) and the reader (the
 * pool's handshake) must agree on ONE value or a stored secret is one the
 * pool can never find. Pinning it here keeps that agreement in one place;
 * `mcpConnectorRow` reports the row's own environment separately so a
 * caller can see the two are not the same question.
 */
export const MCP_CREDENTIAL_ENVIRONMENT = "prod" as const;

/**
 * Non-secret auth shape persisted in `connectors.config.mcp.auth`. Carries
 * ONLY the `kind` discriminator plus the non-secret oauth2 parameters. The
 * actual bearer token / OAuth refresh+access token is resolved from the
 * AES-256-GCM `credentials` table (keyed by `connector_id`) by
 * `session-auth.ts` at handshake time. NEVER inline a secret here — the DB
 * CHECK rejects it.
 */
export interface McpAuthConfig {
  kind:
    | "none"
    | "bearer"
    | "basic"
    | "oauth2"
    | "oauth2_client_credentials"
    | "oauth2_private_key_jwt";
  /** OAuth2 issuer base URL (oauth2 / M2M kinds, documentation only for
   *  M2M since the SDK discovers the token endpoint via RFC 9728 off
   *  `base_url` — not consumed as a provider option). */
  issuer?: string;
  /** OAuth2 client id (oauth2 + M2M kinds). */
  client_id?: string;
  /** OAuth2 scope string (oauth2 + M2M kinds). */
  scope?: string;
  /** JWT signing algorithm for `oauth2_private_key_jwt` (e.g. "RS256",
   *  "ES256"). Stored here (non-secret) alongside the private key in
   *  the encrypted `credentials` row. */
  algorithm?: string;
}

// `.strict()` rejects any stray key (including a leaked secret) at the
// boundary so a bad writer fails Zod validation, not the DB CHECK.
export const McpAuthConfigSchema = z
  .object({
    kind: z.enum([
      "none",
      "bearer",
      "basic",
      "oauth2",
      "oauth2_client_credentials",
      "oauth2_private_key_jwt",
    ]),
    issuer: z.string().url().optional(),
    client_id: z.string().optional(),
    scope: z.string().optional(),
    algorithm: z.string().optional(),
  })
  .strict();

/**
 * The MCP-shaped projection of one connector row. The pool never sees a
 * `ConnectorView`: it needs the endpoint, the transport, the auth shape
 * and the identity, and nothing else on a connector is its business.
 */
export interface McpConnectorRow {
  id: string;
  tenant_id: string;
  /** Namespaces the remote's tools as `mcp_<slug>__<tool>`. */
  slug: string;
  display_name: string;
  transport: "http" | "sse" | "stdio";
  /** The remote endpoint, from `connectors.base_url`. */
  url: string;
  auth: McpAuthConfig;
  environment: "dev" | "prod";
  enabled: boolean;
}

/** Columns the projection reads. Selected explicitly so a widening of
 *  `connectors` cannot silently change what a handshake depends on. */
const MCP_CONNECTOR_COLUMNS = {
  id: connectors.id,
  tenant_id: connectors.tenant_id,
  slug: connectors.slug,
  display_name: connectors.display_name,
  driver: connectors.driver,
  environment: connectors.environment,
  base_url: connectors.base_url,
  config: connectors.config,
  enabled: connectors.enabled,
} as const;

type McpConnectorColumns = {
  [K in keyof typeof MCP_CONNECTOR_COLUMNS]: K extends "config"
    ? Record<string, unknown>
    : K extends "enabled"
      ? boolean
      : K extends "base_url"
        ? string | null
        : string;
};

/**
 * Project a connector row into the MCP shape, or null when the row cannot
 * be one. A row with no `base_url` is not addressable and a malformed
 * `config.mcp` is not a session the engine can negotiate — both return
 * null rather than a half-populated row the pool would fail on later, with
 * an error naming the transport instead of the config.
 */
function projectMcpConnector(row: McpConnectorColumns): McpConnectorRow | null {
  if (row.driver !== "mcp" || !row.base_url) return null;
  const block = (row.config as { mcp?: { transport?: unknown; auth?: unknown } }).mcp ?? {};
  const transport =
    block.transport === "sse" || block.transport === "stdio" || block.transport === "http"
      ? block.transport
      : "http";
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    transport,
    url: row.base_url,
    auth: parseAuthConfig((block.auth as Record<string, unknown> | undefined) ?? null),
    environment: row.environment as "dev" | "prod",
    enabled: row.enabled,
  };
}

/** One `mcp` connector by id, tenant-scoped. Null for a missing row, a
 *  soft-deleted one, or a row whose driver is not `mcp`. */
export async function getMcpConnector(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<McpConnectorRow | null> {
  const rows = await db
    .select(MCP_CONNECTOR_COLUMNS)
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, id),
        eq(connectors.driver, "mcp"),
        isNull(connectors.deleted_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? projectMcpConnector(row) : null;
}

/**
 * Connectable MCP servers for a tenant: every live `mcp` connector an
 * operator has left enabled.
 *
 * A server whose last handshake FAILED is deliberately still here. A
 * transient failure parks it in `degraded` health; excluding degraded rows
 * would leave the server permanently dark even after the remote recovers.
 * The pool gates them on its backoff window instead, so a recovered server
 * is retried once the window elapses. `enabled = false` is an operator
 * decision and is never auto-retried.
 */
export async function listConnectableMcpConnectorsForTenant(
  db: Executor,
  tenant_id: string,
): Promise<McpConnectorRow[]> {
  const rows = await db
    .select(MCP_CONNECTOR_COLUMNS)
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.driver, "mcp"),
        eq(connectors.enabled, true),
        isNull(connectors.deleted_at),
      ),
    );
  return rows.map(projectMcpConnector).filter((r): r is McpConnectorRow => r !== null);
}

// Match any http(s) URL embedded in a raw transport/fetch error so it can
// be reduced to host-only before the text is handed back to a caller.
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>)]+/gi;
// Coarse cap so a verbose remote error body can't bloat a response.
const MAX_UPSTREAM_DETAIL_CHARS = 300;

/**
 * Sanitize a raw transport/fetch error before handing it back IN FLIGHT —
 * the probe envelope and the step result an operator reads in the same
 * breath as the failure. It is deliberately NOT what gets persisted: see
 * `classifyMcpHandshakeFailure` for the column.
 *
 * Two passes, in this order, because they catch different carriers:
 *
 *  1. URL → origin. Raw fetch/transport errors embed the full request URL,
 *     and the query string is where a pre-signed or `?token=` credential
 *     rides. Reducing to `scheme://host` also drops any `user:pass@`
 *     userinfo, which `URL.host` excludes by construction.
 *  2. `scrubString` — the repo's canonical secret redaction, the same one
 *     the logger and the prose guard use. The pass above only reaches
 *     material shaped like a URL, and the shape that actually dominates
 *     here does not have one: the SDK reports a failed handshake as
 *     `Error POSTing to endpoint: <raw response body>`, so the REMOTE
 *     decides what text this carries.
 *
 * The result is then length-capped so a verbose remote body cannot bloat
 * the response it rides in.
 */
export function redactUpstreamDetail(message: string): string {
  const originOnly = message.replace(URL_IN_TEXT_RE, (match) => {
    try {
      const u = new URL(match);
      return `${u.protocol}//${u.host}`;
    } catch {
      return "[url]";
    }
  });
  const sanitized = scrubString(originOnly);
  return sanitized.length > MAX_UPSTREAM_DETAIL_CHARS
    ? `${sanitized.slice(0, MAX_UPSTREAM_DETAIL_CHARS)}…`
    : sanitized;
}

/**
 * A refusal the ENGINE authored: a config gap, a missing or wrong-shaped
 * credential, a transport we do not serve — raised before the handshake
 * ever reaches the remote.
 *
 * The type exists so the engine can tell its own words from a third
 * party's. That is not cosmetic: `classifyMcpHandshakeFailure` carries OUR
 * message into `connectors.last_error` verbatim, and must never carry a
 * remote's. Every engine-authored throw on the connect path raises this;
 * anything else reaching the pool's catch is treated as the remote's.
 */
export class McpPreflightError extends Error {
  constructor(
    readonly error_code: McpPreflightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpPreflightError";
  }
}

/** Engine-side faults. `credential_missing` / `credential_invalid` are the
 *  probe vocabulary (connectors/drivers/index.ts); `mcp_transport_unsupported`
 *  is the code the mcp-server migration already writes for sse/stdio rows. */
export type McpPreflightErrorCode =
  | "credential_missing"
  | "credential_invalid"
  | "config_incomplete"
  | "mcp_transport_unsupported";

/**
 * Machine-readable classification of a failed MCP handshake.
 *
 * The remote-side members are the codes `connectorHealthHint`
 * (connectors/health.ts) already publishes for the same faults on the HTTP
 * driver, so a consumer branches on ONE vocabulary across drivers;
 * `mcp_handshake_failed` is the pre-existing MCP fallback for a failure
 * that never reached HTTP semantics at all (DNS, TLS, connection refused,
 * protocol error). `egress_blocked` mirrors `EgressBlockedError.code`.
 */
export type McpHandshakeErrorCode =
  | McpPreflightErrorCode
  | "egress_blocked"
  | "auth_rejected"
  | "rate_limited"
  | "resource_not_found"
  | "vendor_degraded"
  | "mcp_handshake_failed";

export interface McpHandshakeFault {
  error_code: McpHandshakeErrorCode;
  /** Engine-authored sentence naming what failed. Contains no text the
   *  remote wrote — see `classifyMcpHandshakeFailure`. */
  reason: string;
}

/**
 * `connectClient` collapses the SDK's `UnauthorizedError` into this exact
 * sentence for the detail it hands back in flight. Classification prefers
 * the typed error; this string is the fallback for a caller that already
 * flattened it. If the wording drifts, classification degrades to the
 * generic fallback — it does not start lying.
 */
export const UNAUTHORIZED_HANDSHAKE_MESSAGE = "authorization required";

// The SDK reports a rejected handshake as `Error POSTing to endpoint (HTTP
// 401): <body>`, so the status is the one machine-readable fact inside an
// otherwise remote-authored string.
const HTTP_STATUS_IN_TEXT_RE = /\bHTTP\s+(\d{3})\b/;

/**
 * Turn a handshake failure into an ENGINE-AUTHORED verdict.
 *
 * `connectors.last_error` and `health_reason` are columns operators read,
 * export and render, and the dominant failure shape on this path is a body
 * a third party wrote. Redacting that body means recognising every vendor's
 * token format — a guarantee nobody can keep. So authorship decides what
 * survives:
 *
 *  - `McpPreflightError` and `EgressBlockedError` are the ENGINE refusing.
 *    Their message is ours, so it is carried verbatim — it is also the only
 *    text that says which config or credential is missing.
 *  - anything else came off the wire. Only the HTTP status (a three-digit
 *    number) is read out of it; the sentence is composed here from that
 *    status plus the endpoint host the OPERATOR configured. The upstream
 *    body stays in the structured log, which has retention and access
 *    control a column does not.
 */
export function classifyMcpHandshakeFailure(err: unknown, endpoint_url: string): McpHandshakeFault {
  const host = endpointHostOf(endpoint_url);
  const fault = (error_code: McpHandshakeErrorCode, sentence: string): McpHandshakeFault => ({
    error_code,
    reason: capped(sentence),
  });
  if (err instanceof EgressBlockedError) {
    return fault(
      "egress_blocked",
      `The engine refused to open an MCP session to ${host}: ${err.reason}.`,
    );
  }
  if (err instanceof McpPreflightError) {
    return fault(err.error_code, `The MCP handshake with ${host} never started: ${err.message}`);
  }
  // The SDK raises UnauthorizedError before any status is visible, and
  // `connectClient` collapses it to a fixed sentence for its in-flight
  // detail — recognise both, since a caller may hand back either.
  const raw_error = err instanceof Error ? err.message : String(err);
  const status = Number.parseInt(HTTP_STATUS_IN_TEXT_RE.exec(raw_error)?.[1] ?? "", 10);
  const at = `(HTTP ${status})`;
  if (err instanceof UnauthorizedError || raw_error === UNAUTHORIZED_HANDSHAKE_MESSAGE) {
    return fault(
      "auth_rejected",
      `The external MCP server at ${host} required authorization the connector could not present.`,
    );
  }
  if (status === 401 || status === 403) {
    return fault(
      "auth_rejected",
      `The external MCP server at ${host} rejected the connector's credential during the handshake ${at}.`,
    );
  }
  if (status === 429) {
    return fault(
      "rate_limited",
      `The external MCP server at ${host} rate-limited the handshake ${at}.`,
    );
  }
  if (status === 404 || status === 410) {
    return fault(
      "resource_not_found",
      `The external MCP server at ${host} served no MCP endpoint at the configured URL ${at}.`,
    );
  }
  if (status >= 500 && status <= 599) {
    return fault(
      "vendor_degraded",
      `The external MCP server at ${host} failed the handshake with a server error ${at}.`,
    );
  }
  return fault(
    "mcp_handshake_failed",
    `The MCP handshake with ${host} did not complete. The upstream response is in the engine log for this connector.`,
  );
}

/** Even an engine-authored message is bounded before it reaches a column. */
function capped(sentence: string): string {
  return sentence.length > MAX_UPSTREAM_DETAIL_CHARS
    ? `${sentence.slice(0, MAX_UPSTREAM_DETAIL_CHARS)}…`
    : sentence;
}

/** Host of the operator-configured endpoint. `URL.host` excludes any
 *  `user:pass@` userinfo by construction, so a credential an operator
 *  inlined in `base_url` cannot ride into the sentence. */
function endpointHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured endpoint";
  }
}

/** Persisted shape of `connectors.last_error`: the machine code first so an
 *  operator can grep or branch on it without parsing prose, then the
 *  sentence. */
function formatLastError(fault: McpHandshakeFault): string {
  return `[${fault.error_code}] ${fault.reason}`;
}

/**
 * Record a successful handshake.
 *
 * Two rows move together: the session row gets the observed manifest hash,
 * a fresh `last_handshake_at`, and its backoff cleared; the connector row
 * drops its `last_error` and recovers out of `degraded`. Both happen in
 * ONE transaction — a session that says "healthy" beside a connector still
 * carrying the failure text is the exact disagreement
 * `effectiveConnectorHealth` exists to prevent.
 *
 * SOLE-WRITER CONTRACT (`tools_manifest_hash`): observed-handshake state is
 * the ONLY legitimate origin of this column — this function and the
 * schema-drift reconciler (`schema-drift.ts`), which persists the drifted
 * hash it just observed. It is on the extension table precisely so the
 * connector PATCH surface cannot reach it, which is what makes
 * `connector.mcp_manifest_drift` a claim about the remote rather than
 * about whoever last edited the row.
 */
export async function recordMcpHandshakeState(
  db: Db,
  row: McpConnectorRow,
  tools_manifest_hash: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(connectorMcpSessions)
      .values({
        connector_id: row.id,
        tenant_id: row.tenant_id,
        tools_manifest_hash,
        last_handshake_at: now,
        consecutive_failures: 0,
        backoff_until: null,
      })
      .onConflictDoUpdate({
        target: connectorMcpSessions.connector_id,
        set: {
          tools_manifest_hash,
          last_handshake_at: now,
          consecutive_failures: 0,
          backoff_until: null,
          updated_at: now,
        },
      });
    await tx
      .update(connectors)
      .set({ last_error: null, updated_at: now })
      .where(and(eq(connectors.tenant_id, row.tenant_id), eq(connectors.id, row.id)));
  });
  // Health recovery is its own edge-guarded transaction (it owns the
  // notification + audit row on the edge). Running it after the state
  // write means a recovered server never reports healthy before its
  // session row says so.
  await clearMcpConnectorFailure(db, row);
}

/** Read the persisted handshake backoff for a connector. Survives a
 *  process restart, which the pool's in-memory window does not. */
export async function getMcpSessionBackoff(
  db: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<{ consecutive_failures: number; backoff_until: Date | null } | null> {
  const rows = await db
    .select({
      consecutive_failures: connectorMcpSessions.consecutive_failures,
      backoff_until: connectorMcpSessions.backoff_until,
    })
    .from(connectorMcpSessions)
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, tenant_id),
        eq(connectorMcpSessions.connector_id, connector_id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Park a connector whose handshake failed: persist the ENGINE'S verdict on
 * the failure, count it, arm the backoff window, and flip health to
 * `degraded` (edge-guarded, so a remote that is down for an hour produces
 * one notification, not one per turn).
 *
 * The health STATE stays `degraded` even when the code is `auth_rejected`:
 * the `needs_reauth` edge belongs to reauth.ts, which also owns the
 * `needs_reauth` column that the credential-setup surfaces read. Classifying
 * here sharpens the code and the sentence, not the state machine.
 *
 * Returns the NEW consecutive-failure count, computed by the database
 * rather than read-then-written, so two turns failing concurrently cannot
 * both observe the same prior value and arm the same window.
 */
export async function parkMcpConnectorFailure(
  db: Db,
  row: McpConnectorRow,
  /** The thrown value, NOT a pre-stringified message: the classifier tells
   *  the engine's own refusals from the remote's by type. */
  error: unknown,
  backoffFor: (failures: number) => Date,
): Promise<number> {
  const fault = classifyMcpHandshakeFailure(error, row.url);
  const persistedError = formatLastError(fault);
  const now = new Date();
  const failures = await db.transaction(async (tx) => {
    await tx
      .update(connectors)
      .set({ last_error: persistedError, updated_at: now })
      .where(and(eq(connectors.tenant_id, row.tenant_id), eq(connectors.id, row.id)));
    const result = await tx.execute<{ consecutive_failures: number }>(sql`
      INSERT INTO "connector_mcp_sessions"
        ("connector_id", "tenant_id", "consecutive_failures")
      VALUES (${row.id}, ${row.tenant_id}, 1)
      ON CONFLICT ("connector_id") DO UPDATE
        SET "consecutive_failures" = "connector_mcp_sessions"."consecutive_failures" + 1,
            "updated_at" = ${now}
      RETURNING "consecutive_failures"
    `);
    return Number(result.rows[0]?.consecutive_failures ?? 1);
  });
  await db
    .update(connectorMcpSessions)
    .set({ backoff_until: backoffFor(failures) })
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, row.tenant_id),
        eq(connectorMcpSessions.connector_id, row.id),
      ),
    );
  await setConnectorHealth(
    db,
    { id: row.id, tenant_id: row.tenant_id, slug: row.slug },
    {
      state: "degraded",
      reason: fault.reason,
      error_code: fault.error_code,
    },
  );
  return failures;
}

/** Recover a connector out of the `degraded` state a failed handshake put
 *  it in. A no-op when it was never degraded. */
export async function clearMcpConnectorFailure(db: Db, row: McpConnectorRow): Promise<void> {
  await setConnectorHealth(
    db,
    { id: row.id, tenant_id: row.tenant_id, slug: row.slug },
    {
      state: "ok",
      reason: "handshake ok — external MCP server reachable",
    },
  );
}

/**
 * Persist what the remote agreed to at `initialize`. Written on every
 * handshake because a server may quietly stop declaring a capability
 * between two sessions, and an operator inspecting the connector must see
 * what the LAST session negotiated rather than the first.
 */
export async function recordMcpNegotiation(
  db: Executor,
  row: McpConnectorRow,
  negotiation: {
    protocol_version: string | null;
    server_capabilities: Record<string, unknown> | null;
  },
): Promise<void> {
  await db
    .update(connectorMcpSessions)
    .set({
      negotiated_protocol_version: negotiation.protocol_version,
      server_capabilities: negotiation.server_capabilities,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, row.tenant_id),
        eq(connectorMcpSessions.connector_id, row.id),
      ),
    );
}

/** Parse an arbitrary `config.mcp.auth` blob into the typed shape.
 *  Returns the `none` default when absent. */
export function parseAuthConfig(raw: Record<string, unknown> | null): McpAuthConfig {
  if (!raw) return { kind: "none" };
  const parsed = McpAuthConfigSchema.parse(raw);
  // Drop keys whose value is `undefined` so the result structurally
  // matches `McpAuthConfig` under `exactOptionalPropertyTypes`.
  const out: McpAuthConfig = { kind: parsed.kind };
  if (parsed.issuer !== undefined) out.issuer = parsed.issuer;
  if (parsed.client_id !== undefined) out.client_id = parsed.client_id;
  if (parsed.scope !== undefined) out.scope = parsed.scope;
  if (parsed.algorithm !== undefined) out.algorithm = parsed.algorithm;
  return out;
}

/**
 * Write the non-secret auth block back onto a connector's config.
 *
 * The ONLY writer is the OAuth provider mirroring a dynamically-registered
 * (RFC 7591) `client_id`, or clearing it so the next flow re-registers.
 * It goes through here rather than the connector update service because
 * that path re-validates and re-audits an operator edit, and a DCR mirror
 * is neither.
 */
export async function updateMcpAuthConfig(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  auth: McpAuthConfig,
  auditCtx: { actor_id: string | null; request_source: RequestSource },
): Promise<void> {
  const parsed = McpAuthConfigSchema.parse(auth);
  const [row] = await db
    .update(connectors)
    .set({
      config: sql`jsonb_set(
        jsonb_set(coalesce(${connectors.config}, '{}'::jsonb), '{mcp}', coalesce(${connectors.config} -> 'mcp', '{}'::jsonb), true),
        '{mcp,auth}', ${JSON.stringify(parsed)}::jsonb, true)`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, connector_id),
        eq(connectors.driver, "mcp"),
      ),
    )
    .returning({ slug: connectors.slug });
  if (!row) return;
  await recordConnectorMcpClientRegistered({
    tenant_id,
    actor_id: auditCtx.actor_id,
    connector_id,
    connector_slug: row.slug,
    client_id: parsed.client_id ?? null,
    request_source: auditCtx.request_source,
    executor: db,
  });
}
