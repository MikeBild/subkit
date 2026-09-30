// Per-tenant external MCP Client pool.
//
// subkit's conversation loop merges the tools of every active external
// MCP server a tenant registered into the LLM's tool palette. This module
// owns the live `@modelcontextprotocol/sdk` Client connections, their
// cached tool manifests, handshake/credential resolution, backoff on
// failure, and per-server token-budget truncation.
//
// THIS MODULE OWNS THE CONNECTION. The `mcp` connector driver
// (connectors/drivers/mcp.ts) is a thin facade in front of this pool and
// holds no socket, no manifest and no backoff of its own. Every other
// connector driver is stateless per request and opens its own transport;
// this one deliberately is not, because an MCP session is a negotiated
// handshake plus a cached tool manifest that would be re-paid on every
// step. Keep the state here — a second owner would be a second answer to
// "is this server connected?".
//
// HARD ISOLATION INVARIANT: the pool is keyed STRICTLY by `tenant_id`. A
// Client is NEVER shared across tenants — each tenant's Clients carry that
// tenant's resolved credentials, and a cross-tenant leak would expose one
// workspace's bearer token / OAuth access token to another's turn. Every
// connection, manifest, and tool result lives under its tenant's bucket.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { classifyMcpToolSideEffect, type SideEffect } from "@shared/index.ts";
import {
  recordConnectorMcpHandshakeOk,
  recordMcpExternalToolInvoked,
} from "../../audit/recorders/index.ts";
import { getConfig } from "../../config/loader.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import {
  capManifest,
  hashManifest,
  PER_SERVER_MANIFEST_BYTE_CAP,
  type RemoteToolDescriptor,
} from "./manifest.ts";
import {
  getMcpConnector,
  getMcpSessionBackoff,
  listConnectableMcpConnectorsForTenant,
  MCP_CREDENTIAL_ENVIRONMENT,
  type McpConnectorRow,
  McpPreflightError,
  type McpPreflightErrorCode,
  parkMcpConnectorFailure,
  recordMcpHandshakeState,
  recordMcpNegotiation,
  redactUpstreamDetail,
  UNAUTHORIZED_HANDSHAKE_MESSAGE,
} from "./registry.ts";
import {
  MCP_REQUIRED_CAPABILITY,
  MCP_WIRE_METHOD,
  performRemoteCall,
  type RemoteCall,
  remoteCallTarget,
} from "./remote-call.ts";
import { reconcileManifestHash } from "./schema-drift.ts";
import {
  type McpClientLike,
  type McpSessionFactories,
  type NegotiatedServerCapabilities,
  type OpenMcpSessionResult,
  openMcpSession,
  setMcpSessionFactoriesForTests,
} from "./session.ts";
import { invalidateOAuth2TokenForServer, isUnauthorized } from "./session-auth.ts";

// Exponential backoff on handshake failure: base * 2^(failures-1), capped.
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
// Bounded per-invocation timeout for a remote `tools/call`. A hung remote
// must NOT wedge the turn forever — it holds the toolChain mutex, so the
// whole conversation stalls. Half the HTTP driver's 60s fetch default:
// long enough for a legitimately slow tool, short enough that a dead
// remote surfaces a clean tool error instead of an indefinite hang. On
// expiry the SDK raises an McpError(RequestTimeout) we catch below.
// DEFAULT for the tenant-scoped `connectors.mcp.remote_tool_call_timeout_ms`
// config leaf (read at use via `remoteToolCallTimeoutMs`); the schema
// default mirrors this value.
const REMOTE_TOOL_CALL_TIMEOUT_MS = 30_000;

/** Effective remote `tools/call` timeout for a tenant. Falls back to the
 *  module default when the config loader is not initialised (unit tests). */
function remoteToolCallTimeoutMs(tenant_id: string): number {
  try {
    return getConfig(tenant_id).connectors.mcp.remote_tool_call_timeout_ms;
  } catch {
    return REMOTE_TOOL_CALL_TIMEOUT_MS;
  }
}

// ── TEST SEAM ────────────────────────────────────────────────────────────────
// Overrides SDK client/transport construction in the shared session opener.
// Production never sets this; tests inject in-process fakes WITHOUT bun's
// `mock.module` (module mocks are process-global and leak into every other
// test file that builds an SDK Client in the same worker). Null by default,
// so even a missed restore can never alter production behavior — but tests
// MUST still restore null in afterAll so a fake doesn't bleed into sibling
// test files that also set the seam.

// Re-exported so the loop and route layers keep one import path for the
// descriptor even though the shape now lives with the manifest logic.
export type { RemoteToolDescriptor } from "./manifest.ts";
export type {
  McpClientLike,
  NegotiatedServerCapabilities,
  ServerCapabilitiesLike,
} from "./session.ts";
export type McpPoolTestFactories = McpSessionFactories;

export function __setMcpPoolFactoriesForTests(f: McpPoolTestFactories | null): void {
  setMcpSessionFactoriesForTests(f);
}

interface PooledClient {
  client: McpClientLike;
  slug: string;
  connector_id: string;
  tools: RemoteToolDescriptor[];
  manifest_hash: string;
  /** What the server declared at `initialize`, captured once per
   *  handshake. Read before every resources/prompts call and before the
   *  read-only adapters are minted; `null` when the client could not be
   *  asked. */
  capabilities: NegotiatedServerCapabilities | null;
  /** The server's self-reported name/version and free-text instructions,
   *  carried for the operator-facing inspect surface. Neither is trusted
   *  for any decision. */
  server_version: Record<string, unknown> | null;
  instructions: string | null;
  last_heartbeat_at: number;
  /** Epoch ms before which this server is skipped (set on failure). */
  backoff_until: number;
  consecutive_failures: number;
}

interface TenantMcpPool {
  // Keyed by connector_id. A failed server keeps a placeholder entry
  // carrying its backoff window so `getTenantMcpTools` can honour it
  // without re-attempting a connect every turn.
  clients: Map<string, PooledClient>;
  // Backoff windows for servers that failed before a PooledClient existed.
  backoff: Map<string, { backoff_until: number; consecutive_failures: number }>;
}

// HARD ISOLATION INVARIANT (see file header): keyed STRICTLY by tenant_id.
// Never key by anything coarser and never share a Client across tenants.
const POOL = new Map<string, TenantMcpPool>();

function tenantBucket(tenant_id: string): TenantMcpPool {
  let bucket = POOL.get(tenant_id);
  if (!bucket) {
    bucket = { clients: new Map(), backoff: new Map() };
    POOL.set(tenant_id, bucket);
  }
  return bucket;
}

function backoffWindow(failures: number): number {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  return Date.now() + delay;
}

/**
 * Connect (or reconnect) a single server: build the transport, resolve
 * auth by reference, handshake, list tools, hash + cap the manifest,
 * reconcile drift, persist handshake state, and audit. On failure parks
 * the server in `error` status and arms exponential backoff. Returns the
 * live PooledClient, or null if the connect failed.
 */
type ConnectClientOutcome = { pooled: PooledClient } | { pooled: null; error: string };

async function connectClient(
  db: Db,
  tenant_id: string,
  row: McpConnectorRow,
  environment: "dev" | "prod",
  requestSource: RequestSource,
): Promise<ConnectClientOutcome> {
  const bucket = tenantBucket(tenant_id);
  try {
    const opened = await openMcpSession(db, tenant_id, row, environment, requestSource);
    const {
      client,
      tools,
      manifest_hash,
      capabilities,
      server_version,
      instructions,
      readNegotiatedProtocolVersion,
    } = opened;

    // Reconcile against the last-observed hash (drift detection + audit).
    // Done before persisting the new handshake state so the previous hash
    // is still on the row when reconcile reads it.
    await reconcileManifestHash({
      db,
      tenant_id,
      connector_id: row.id,
      connector_slug: row.slug,
      observed_hash: manifest_hash,
      observed_tool_count: tools.length,
      auditCtx: { actor_id: null, request_source: requestSource, executor: db },
    });

    await recordMcpHandshakeState(db, row, manifest_hash);
    // What the remote agreed to, persisted so an operator can read it
    // without forcing a fresh handshake. Written after the session row
    // exists — `recordMcpHandshakeState` is what creates it.
    // A client that never told the transport a version leaves the column
    // NULL rather than being backfilled with the version we ASKED for:
    // "what we proposed" and "what the two sides agreed" are different
    // claims, and an operator reading this column is asking the second.
    await recordMcpNegotiation(db, row, {
      protocol_version: readNegotiatedProtocolVersion(),
      server_capabilities: (client.getServerCapabilities?.() ?? null) as Record<
        string,
        unknown
      > | null,
    });
    await recordConnectorMcpHandshakeOk({
      tenant_id,
      actor_id: null,
      connector_id: row.id,
      connector_slug: row.slug,
      tool_count: tools.length,
      manifest_hash,
      request_source: requestSource,
      executor: db,
    });

    const pooled: PooledClient = {
      client,
      slug: row.slug,
      connector_id: row.id,
      tools,
      manifest_hash,
      capabilities,
      server_version,
      instructions,
      last_heartbeat_at: Date.now(),
      backoff_until: 0,
      consecutive_failures: 0,
    };
    bucket.clients.set(row.id, pooled);
    bucket.backoff.delete(row.id);
    return { pooled };
  } catch (err) {
    // An oauth2 server with no usable token makes the SDK transport raise
    // UnauthorizedError on connect (its authProvider.redirectToAuthorization
    // no-ops in non-interactive mode, so no browser opens and no URL leaks).
    // Surface a stable, URL-free reason and park the server in error+backoff
    // exactly like any other handshake failure — getTenantMcpTools skips
    // error+backoff servers, so the turn proceeds with this server absent
    // rather than crashing. The operator triggers the interactive authorize
    // flow (owned by the route layer) to mint a token.
    const message =
      err instanceof UnauthorizedError
        ? UNAUTHORIZED_HANDSHAKE_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err);
    // Prior failures live only in the backoff map: a pooled client's own
    // counter is always 0 (a successful connect resets it), so there is no
    // clients-map fallback to consult.
    const prior = bucket.backoff.get(row.id)?.consecutive_failures ?? 0;
    const failures = prior + 1;
    bucket.backoff.set(row.id, {
      consecutive_failures: failures,
      backoff_until: backoffWindow(failures),
    });
    // Drop any stale live client for this server.
    const stale = bucket.clients.get(row.id);
    if (stale) {
      bucket.clients.delete(row.id);
      void stale.client.close().catch(() => {});
    }
    // Persist the failure alongside the in-memory window: the backoff a
    // process holds dies with it, and a server that has been refusing for
    // an hour should not be re-tried at full rate because the engine
    // restarted. The DB counter is the durable one; the map is the
    // per-process fast path that avoids a read per turn.
    // The thrown value, not `message`: only the error's TYPE says whether
    // the engine or the remote authored the text, and the column may carry
    // ours.
    await parkMcpConnectorFailure(db, row, err, (n) => new Date(backoffWindow(n)));
    logger.warn({
      module: "mcp_client",
      action: "handshake.failed",
      msg: "external MCP server handshake failed; armed backoff",
      tenant_id,
      connector_id: row.id,
      connector_slug: row.slug,
      consecutive_failures: failures,
      error: message,
    });
    // The message is handed back (redacted) rather than only logged: an
    // operator-driven probe has to say WHY the handshake failed, and
    // `last_error` on the row is the engine's own rolled-up verdict, not
    // this attempt's upstream detail.
    return { pooled: null, error: redactUpstreamDetail(message) };
  }
}

export type TransientMcpProbeOutcome =
  | { ok: true; tool_count: number; manifest_hash: string }
  | { ok: false; detail: string; preflight_error_code?: McpPreflightErrorCode };

/** Probe an unsaved MCP connector without touching pool or persistence state. */
export async function probeTransientMcpServer(p: {
  db: Db;
  tenant_id: string;
  row: McpConnectorRow;
  credential: DecryptedCredential | null;
  requestSource?: RequestSource;
}): Promise<TransientMcpProbeOutcome> {
  let opened: OpenMcpSessionResult | null = null;
  try {
    opened = await openMcpSession(
      p.db,
      p.tenant_id,
      p.row,
      p.row.environment,
      p.requestSource ?? "chat",
      p.credential,
    );
    return {
      ok: true,
      tool_count: opened.tools.length,
      manifest_hash: opened.manifest_hash,
    };
  } catch (error) {
    const message =
      error instanceof UnauthorizedError
        ? UNAUTHORIZED_HANDSHAKE_MESSAGE
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      detail: redactUpstreamDetail(message),
      ...(error instanceof McpPreflightError ? { preflight_error_code: error.error_code } : {}),
    };
  } finally {
    await opened?.client.close().catch(() => {});
  }
}

export interface TenantMcpToolSet {
  slug: string;
  connector_id: string;
  tools: RemoteToolDescriptor[];
  /** What the server declared it serves. Carried out of the pool so the
   *  palette can mint a resources or prompts adapter ONLY for a server
   *  that said it has them — the alternative is offering the model a tool
   *  whose every call is a protocol error. `null` when unknown, which
   *  mints nothing. */
  capabilities: NegotiatedServerCapabilities | null;
  /** The remote's free-text `instructions`, verbatim. Third-party prose:
   *  useful to show an operator, never an instruction the engine follows. */
  instructions: string | null;
  /** The remote's self-reported `implementation` block — which build of
   *  which server this session is actually talking to. Carried for the
   *  operator surface; nothing branches on it, because a server naming
   *  itself proves nothing. */
  server_version: Record<string, unknown> | null;
}

function toolSetOf(pooled: PooledClient): TenantMcpToolSet {
  return {
    slug: pooled.slug,
    connector_id: pooled.connector_id,
    tools: pooled.tools,
    capabilities: pooled.capabilities,
    instructions: pooled.instructions,
    server_version: pooled.server_version,
  };
}

/**
 * Lazily connect a tenant's connectable external MCP servers and return
 * their cached tool manifests. A server already cached is reused; one
 * inside a backoff window is skipped; one not yet connected is connected
 * now. Consumed by the loop layer to assemble the merged tool palette.
 *
 * RECOVERY: we enumerate `listConnectableMcpConnectorsForTenant` (active OR
 * error), NOT just active. A transient handshake failure parks a server
 * in `error` status; a plain active-only filter would then exclude it
 * forever (permanently dark) even after the remote recovers. Error-status
 * rows are gated on the same in-memory exponential backoff window, so a
 * recovered server is retried once its backoff elapses — a successful
 * handshake recovers it to `active` via `recordMcpServerHandshakeState`.
 */
export async function getTenantMcpTools(
  db: Db,
  tenant_id: string,
  opts?: { environment?: "dev" | "prod"; requestSource?: RequestSource },
): Promise<TenantMcpToolSet[]> {
  const environment = opts?.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
  const requestSource: RequestSource = opts?.requestSource ?? "chat";
  const bucket = tenantBucket(tenant_id);
  const servers = await listConnectableMcpConnectorsForTenant(db, tenant_id);
  const now = Date.now();
  const out: TenantMcpToolSet[] = [];

  for (const row of servers) {
    const cached = bucket.clients.get(row.id);
    if (cached) {
      out.push(toolSetOf(cached));
      continue;
    }
    // Respect an armed backoff window: skip this server this turn.
    const window = bucket.backoff.get(row.id);
    if (window && window.backoff_until > now) continue;
    // The in-memory window dies with the process. A restart must not
    // reset a server that has been refusing for an hour back to full
    // rate, so the persisted window is consulted whenever this process
    // holds none — and adopted into the map so the next turn costs no
    // read.
    if (!window) {
      const persisted = await getMcpSessionBackoff(db, tenant_id, row.id);
      const until = persisted?.backoff_until?.getTime() ?? 0;
      if (until > now) {
        bucket.backoff.set(row.id, {
          backoff_until: until,
          consecutive_failures: persisted?.consecutive_failures ?? 1,
        });
        continue;
      }
    }

    const outcome = await connectClient(db, tenant_id, row, environment, requestSource);
    if (outcome.pooled) out.push(toolSetOf(outcome.pooled));
  }
  return out;
}

/**
 * Force a fresh handshake against ONE server by id, REGARDLESS of its
 * status (active OR error) and IGNORING any armed backoff window. Used by
 * the HTTP inspect route to let an operator probe a parked/erroring server
 * on demand — backoff is for the automatic palette-assembly path, not for
 * a deliberate operator-driven inspect. `disabled` servers are not
 * connected (an operator disabled them on purpose); the caller gets null.
 * On success the server is recovered to `active`; on failure it is parked
 * in `error` + backoff exactly as the palette path does.
 *
 * The three failure modes are DISTINCT in the return value rather than
 * collapsed into a null. A caller that has to pick an error code — the
 * connector probe does — cannot tell "no such row" from "an operator
 * disabled it" from "the remote refused the handshake" without them, and
 * re-deriving the reason means a second read that can disagree with the
 * one this call just performed.
 */
export type ConnectServerOutcome =
  | { ok: true; tools: TenantMcpToolSet }
  | { ok: false; reason: "not_found" | "disabled" | "handshake_failed"; detail: string | null };

export async function connectServerById(
  db: Db,
  tenant_id: string,
  connector_id: string,
  opts?: { environment?: "dev" | "prod"; requestSource?: RequestSource },
): Promise<ConnectServerOutcome> {
  const environment = opts?.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
  const requestSource: RequestSource = opts?.requestSource ?? "chat";
  const row = await getMcpConnector(db, tenant_id, connector_id);
  if (!row) return { ok: false, reason: "not_found", detail: null };
  if (!row.enabled) return { ok: false, reason: "disabled", detail: null };
  // Clear any armed backoff so the operator's inspect is honoured now.
  tenantBucket(tenant_id).backoff.delete(connector_id);
  const outcome = await connectClient(db, tenant_id, row, environment, requestSource);
  if (!outcome.pooled) {
    return { ok: false, reason: "handshake_failed", detail: outcome.error };
  }
  return { ok: true, tools: toolSetOf(outcome.pooled) };
}

export interface InvokeRemoteToolInput {
  db: Db;
  tenant_id: string;
  /** Principal that drove this invocation (chat user / system account),
   *  or null for a genuinely actor-less system path. Threaded into the
   *  `mcp_external_tool.invoked` audit row so a real user's invocation is
   *  attributed to that user, not blurred into a system actor. */
  actor_id: string | null;
  connector_id: string;
  connector_slug: string;
  /** Which of the three MCP operations to issue, with its target and
   *  arguments already resolved. See `RemoteCall`. */
  call: RemoteCall;
  environment?: "dev" | "prod";
  requestSource?: RequestSource;
  /** Per-call bound, overriding the tenant's
   *  `connectors.mcp.remote_tool_call_timeout_ms`. Present so a connector can
   *  carry its own value for a remote that is legitimately slower than the
   *  tenant default — the caller supplies an already-validated number; the
   *  bound itself is enforced where the value is authored. */
  timeout_ms?: number;
  /** Cancels THIS call. The turn's abort signal reaches the remote here,
   *  so a user who stops a turn stops the outbound request rather than
   *  waiting out its timeout. The pooled session is shared by every call
   *  in the tenant and is NOT torn down on an abort. */
  signal?: AbortSignal;
  /** Remote progress notifications, forwarded verbatim. Reporting
   *  progress does not extend the deadline — see `RemoteCallOptions`. */
  onProgress?: (p: { progress: number; total?: number; message?: string }) => void;
  /** The rule that let this call skip the confirm pause, recorded on the
   *  `mcp_external_tool.invoked` row. Absent for a confirmed call. */
  gate_rule?: "connector_trust";
}

export interface InvokeRemoteToolResult {
  ok: boolean;
  /** The VERBATIM remote content — exactly what the server returned, with
   *  NO truncation applied here. DETERMINISM: no wall-clock / random is
   *  injected, so the caller persists this raw payload and a replay yields
   *  a stable result. The caller is responsible for producing the
   *  truncated MODEL-FACING view (via the canonical `truncateForLlm`); the
   *  pool must not pre-truncate, or `get_raw_result` would hand back an
   *  already-clipped payload and break the raw-recovery contract. */
  content: unknown;
  /** The tool's typed reply, when it sent one — verbatim, and only for a
   *  tool that declared an `outputSchema`, since the SDK validated it
   *  against that schema before it got here. Absent otherwise. */
  structured_content?: unknown;
  bytes: number;
  /**
   * WHICH LAYER failed, or null on success. A single `ok:false` collapsed
   * outcomes a caller has to tell apart: a retry is worth issuing against
   * `not_connected` and `transport`, pointless against `remote_error`, and
   * WRONG against `cancelled`. Only the first two are evidence about the
   * remote's availability — counting a tool that answered "that argument
   * is wrong" would open the connector's breaker on the author's own
   * mistake, and counting a call the user stopped would punish the
   * connector for the user's decision.
   */
  failure: "not_connected" | "transport" | "remote_error" | "cancelled" | null;
}

/**
 * Which layer a thrown call failed at.
 *
 * The distinction that was missing and is already live: the SDK validates
 * `structuredContent` against the tool's own declared `outputSchema`
 * INSIDE `callTool`, and raises an `McpError` when it does not conform.
 * Read as a transport failure that would evict a healthy pooled session,
 * arm backoff, and — because the 401 detector matches the digit sequence
 * `401` anywhere in a message — delete the server's OAuth token if the
 * validator's complaint happened to mention it. A peer that answered is
 * not a dead socket, whatever it answered.
 *
 * So: only the two codes that mean "no answer arrived" are transport. Any
 * other `McpError` came back over a working connection and is the
 * remote's answer about the call. An abort is neither — the caller stopped
 * it, and the session it rode on is still good.
 */
function classifyCallFailure(
  err: unknown,
  signal: AbortSignal | undefined,
): "transport" | "remote_error" | "cancelled" {
  if (signal?.aborted === true) return "cancelled";
  if (err instanceof Error && err.name === "AbortError") return "cancelled";
  if (err instanceof McpError) {
    return err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout
      ? "transport"
      : "remote_error";
  }
  return "transport";
}

/**
 * Issue one operation against a tenant's external MCP server, connecting
 * on demand. Returns the FULL, verbatim remote content (the caller
 * persists it for determinism and derives the truncated model view
 * itself). The call is bounded by the tenant's
 * `connectors.mcp.remote_tool_call_timeout_ms` unless the caller supplies its
 * own bound; on timeout / transport error the result is `ok:false` with
 * `failure:"transport"` and the (now likely dead) pooled client is evicted
 * so the next call reconnects.
 */
export async function invokeRemoteTool(
  args: InvokeRemoteToolInput,
): Promise<InvokeRemoteToolResult> {
  const environment = args.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
  const requestSource: RequestSource = args.requestSource ?? "chat";
  const bucket = tenantBucket(args.tenant_id);
  let pooled = bucket.clients.get(args.connector_id);
  if (!pooled) {
    // Lazily (re)connect on demand if the palette was assembled in a prior
    // turn that didn't warm this server. Enumerate connectable rows (active
    // OR error) so an error-status server past its backoff is still
    // invokable rather than permanently dark.
    const servers = await listConnectableMcpConnectorsForTenant(args.db, args.tenant_id);
    const row = servers.find((s) => s.id === args.connector_id);
    if (!row) {
      return {
        ok: false,
        content: { error: "no enabled mcp connector with this id" },
        bytes: 0,
        failure: "not_connected",
      };
    }
    const outcome = await connectClient(args.db, args.tenant_id, row, environment, requestSource);
    if (!outcome.pooled) {
      return {
        ok: false,
        content: { error: `mcp connector handshake failed: ${outcome.error}` },
        bytes: 0,
        failure: "not_connected",
      };
    }
    pooled = outcome.pooled;
  }

  // The capability gate. A server that never declared `resources` cannot
  // serve `resources/read`, and asking anyway makes the SDK throw a plain
  // Error the catch below would read as a dead socket — evicting a healthy
  // session and arming backoff because a step named the wrong operation.
  // Answering here says what actually happened. A `null` capability set
  // (the client could not be asked) passes: refusing on an unanswered
  // question would break every in-process fake that only implements the
  // tool path.
  const required = MCP_REQUIRED_CAPABILITY[args.call.operation];
  if (pooled.capabilities && !pooled.capabilities[required]) {
    return {
      ok: false,
      content: {
        error: `mcp server declared no '${required}' capability, so it cannot serve ${MCP_WIRE_METHOD[args.call.operation]}`,
      },
      bytes: 0,
      failure: "remote_error",
    };
  }

  const started = Date.now();
  let outcome: "success" | "error" | "cancelled" = "success";
  let failure: InvokeRemoteToolResult["failure"] = null;
  let transportFailed = false;
  let unauthorized = false;
  let content: unknown;
  let structured_content: unknown;
  let hasStructured = false;
  try {
    // Bounded timeout via the SDK RequestOptions. Without it a hung remote
    // never returns and the held toolChain mutex wedges the entire turn.
    // Per-tenant value from `connectors.mcp.remote_tool_call_timeout_ms`.
    const res = await performRemoteCall(pooled.client, args.call, {
      timeout_ms: args.timeout_ms ?? remoteToolCallTimeoutMs(args.tenant_id),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    });
    content = res.content;
    if (res.structured_content !== undefined) {
      structured_content = res.structured_content;
      hasStructured = true;
    }
    if (res.remote_error) {
      outcome = "error";
      failure = "remote_error";
    }
    pooled.last_heartbeat_at = Date.now();
  } catch (err) {
    // Never throw out of the turn: every failure becomes a tool error. Only
    // a genuine TRANSPORT failure evicts the pooled client — a remote that
    // answered (including one whose structured output failed its own
    // schema) leaves the session alone, and a cancelled call leaves the
    // session alone because the session was never the problem.
    failure = classifyCallFailure(err, args.signal);
    outcome = failure === "cancelled" ? "cancelled" : "error";
    transportFailed = failure === "transport";
    unauthorized = transportFailed && isUnauthorized(err);
    content = { error: err instanceof Error ? err.message : String(err) };
  }

  // Raw byte count for the audit metadata (bucketed there). The content is
  // returned VERBATIM — truncation of the model-facing view is the caller's
  // job (truncateForLlm), so the persisted raw payload stays intact for
  // get_raw_result / replay determinism.
  const serialized = (() => {
    try {
      return JSON.stringify(hasStructured ? { content, structured_content } : content) ?? "";
    } catch {
      return "";
    }
  })();
  const rawBytes = Buffer.byteLength(serialized, "utf8");

  if (transportFailed) {
    invalidateCachedManifest(args.tenant_id, args.connector_id);
    // A mid-session 401 means the cached token is dead. Evicting the client
    // alone is not enough: the next connect would replay the SAME
    // locally-not-yet-expired token and 401 forever. Invalidate the oauth2
    // token credential so the next handshake has no token → the SDK raises
    // UnauthorizedError on connect → the pool parks "authorization required"
    // (operator re-runs the interactive authorize flow) instead of looping.
    // Tenant/server-scoped, oauth2 only — bearer/none have no token to drop.
    if (unauthorized) {
      await invalidateOAuth2TokenForServer(
        args.db,
        args.tenant_id,
        args.connector_id,
        environment,
        requestSource,
      );
    }
  }

  const advertised = advertisedSideEffect(pooled, args.call);
  await recordMcpExternalToolInvoked({
    tenant_id: args.tenant_id,
    actor_id: args.actor_id,
    connector_id: args.connector_id,
    connector_slug: args.connector_slug,
    remote_tool: remoteCallTarget(args.call),
    operation: MCP_WIRE_METHOD[args.call.operation],
    outcome,
    // What the server CLAIMS about the tool it just ran, when it claimed
    // anything. Recorded so an operator can reconcile "the remote said
    // this was read-only" against "the engine gated it as a write" —
    // which is the whole point of not letting the claim decide.
    ...(advertised !== null ? { advertised_side_effect: advertised } : {}),
    structured: hasStructured,
    ...(args.gate_rule ? { gate_rule: args.gate_rule } : {}),
    duration_ms: Date.now() - started,
    byte_count: rawBytes,
    request_source: requestSource,
    executor: args.db,
  });

  return {
    ok: outcome === "success",
    content,
    ...(hasStructured ? { structured_content } : {}),
    bytes: rawBytes,
    failure,
  };
}

/** What the remote's own annotations claim about this call, or null when
 *  it made no claim (or the call addresses no tool). Advisory only — the
 *  gate never reads it, see `classifyMcpToolSideEffect`. */
function advertisedSideEffect(pooled: PooledClient, call: RemoteCall): SideEffect | null {
  if (call.operation !== "call_tool") return null;
  const descriptor = pooled.tools.find((t) => t.name === call.tool);
  if (!descriptor?.annotations) return null;
  return classifyMcpToolSideEffect(descriptor.annotations);
}

/** Drop + close every Client for a tenant — the tenant-wide eviction
 *  primitive (e.g. tenant teardown). Single-server mutations (PATCH /
 *  disable / DELETE / inspect) use `evictServer` instead so siblings stay
 *  warm. */
export function evictTenant(tenant_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  for (const pooled of bucket.clients.values()) {
    void pooled.client.close().catch(() => {});
  }
  POOL.delete(tenant_id);
}

/**
 * Drop just ONE server's cached client + backoff window from its tenant
 * pool, leaving every other server in that tenant untouched. Use this on a
 * single-server mutation (PATCH / disable / DELETE / inspect) so rotating
 * one server's credential, disabling, or deleting it doesn't force a cold
 * reconnect of every other healthy server in the same tenant. The
 * whole-tenant drop (`evictTenant`) is reserved for genuine tenant-wide
 * operations. Closes the live socket and clears any armed backoff so the
 * next `getTenantMcpTools` reconnects this server fresh.
 */
export function evictServer(tenant_id: string, connector_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  const pooled = bucket.clients.get(connector_id);
  if (pooled) {
    bucket.clients.delete(connector_id);
    void pooled.client.close().catch(() => {});
  }
  bucket.backoff.delete(connector_id);
}

/** Drop the cached manifest (and live Client) for a single server so the
 *  next `getTenantMcpTools` re-lists tools. Called by the schema-drift
 *  reconciler when the remote manifest changed. */
export function invalidateCachedManifest(tenant_id: string, connector_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  const pooled = bucket.clients.get(connector_id);
  if (pooled) {
    bucket.clients.delete(connector_id);
    void pooled.client.close().catch(() => {});
  }
}

/** Test/diagnostic hook: clear the entire pool. */
export function __resetMcpClientPoolForTests(): void {
  for (const bucket of POOL.values()) {
    for (const pooled of bucket.clients.values()) {
      void pooled.client.close().catch(() => {});
    }
  }
  POOL.clear();
}

/** Test-only surface for the manifest hashing + token-cap logic, so the
 *  determinism (order-independent hash) and truncation properties can be
 *  asserted without standing up a live MCP server. */
export const __mcpClientInternalsForTests = {
  hashManifest,
  capManifest,
  PER_SERVER_MANIFEST_BYTE_CAP,
  REMOTE_TOOL_CALL_TIMEOUT_MS,
};
