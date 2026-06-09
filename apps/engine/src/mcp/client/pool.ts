// Per-tenant external MCP Client pool (#171).
//
// subkit's conversation loop merges the tools of every active external
// MCP server a tenant registered into the LLM's tool palette. This module
// owns the live `@modelcontextprotocol/sdk` Client connections, their
// cached tool manifests, handshake/credential resolution, backoff on
// failure, and per-server token-budget truncation.
//
// HARD ISOLATION INVARIANT: the pool is keyed STRICTLY by `tenant_id`. A
// Client is NEVER shared across tenants — each tenant's Clients carry that
// tenant's resolved credentials, and a cross-tenant leak would expose one
// workspace's bearer token / OAuth access token to another's turn. Every
// connection, manifest, and tool result lives under its tenant's bucket.

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  recordMcpExternalToolInvoked,
  recordMcpServerHandshakeOk,
} from "../../audit/recorders/index.ts";
import { assertEgressAllowed } from "../../connectors/egress-guard.ts";
import { isTokenExpired, runRefreshTokenGrant } from "../../credentials/oauth2/client.ts";
import { getCredentialForMcpServer, rotateOAuth2Tokens } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import {
  getMcpServer,
  listConnectableMcpServersForTenant,
  type McpServerAuthConfig,
  type McpServerRow,
  parseAuthConfig,
  recordMcpServerHandshakeState,
  setMcpServerStatus,
} from "./registry.ts";
import { reconcileManifestHash } from "./schema-drift.ts";

// A tool manifest, serialized, larger than this is truncated before it is
// handed to the loop layer (which spends it on the prompt budget). ~30 KB
// per server keeps a handful of registered servers from blowing the
// context window on their own.
const PER_SERVER_MANIFEST_BYTE_CAP = 30_000;
// Exponential backoff on handshake failure: base * 2^(failures-1), capped.
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
// Bounded per-invocation timeout for a remote `tools/call`. A hung remote
// must NOT wedge the turn forever — it holds the toolChain mutex, so the
// whole conversation stalls. Half the HTTP driver's 60s fetch default:
// long enough for a legitimately slow tool, short enough that a dead
// remote surfaces a clean tool error instead of an indefinite hang. On
// expiry the SDK raises an McpError(RequestTimeout) we catch below.
const REMOTE_TOOL_CALL_TIMEOUT_MS = 30_000;

/** A remote tool, reduced to the fields the loop layer needs to convert
 *  it into an AI SDK `Tool`. `ai@6` ships no `createMCPClient`, so the
 *  loop does that conversion by hand from this descriptor. */
export interface RemoteToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface PooledClient {
  client: Client;
  namespace: string;
  mcp_server_id: string;
  tools: RemoteToolDescriptor[];
  manifest_hash: string;
  last_heartbeat_at: number;
  /** Epoch ms before which this server is skipped (set on failure). */
  backoff_until: number;
  consecutive_failures: number;
}

interface TenantMcpPool {
  // Keyed by mcp_server_id. A failed server keeps a placeholder entry
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

/** Canonical JSON of a value with object keys sorted recursively, so the
 *  manifest hash is stable regardless of remote key ordering. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function hashManifest(tools: RemoteToolDescriptor[]): string {
  return createHash("sha256").update(canonicalJson(tools)).digest("hex");
}

/**
 * Apply the per-server manifest token cap. When the serialized tool list
 * exceeds the cap, keep the MOST tools that fit, preferring to keep the
 * lighter ones (so the heaviest tools are dropped first). A server that
 * exposes at least one tool ALWAYS keeps at least its smallest tool —
 * even if that one tool alone is over the cap — so the server is never
 * silently reduced to an empty palette (it would then look like it has no
 * tools at all). Returns the (possibly truncated) tool list.
 */
function capManifest(
  tenant_id: string,
  namespace: string,
  mcp_server_id: string,
  tools: RemoteToolDescriptor[],
): RemoteToolDescriptor[] {
  if (canonicalJson(tools).length <= PER_SERVER_MANIFEST_BYTE_CAP) return tools;
  // Sort ascending by serialized weight so we greedily admit the lightest
  // tools first and the heaviest are the ones dropped when the budget runs
  // out — fitting the most tools under the cap.
  const weighted = tools
    .map((t) => ({ tool: t, weight: canonicalJson(t).length }))
    .sort((a, b) => a.weight - b.weight);
  const kept: RemoteToolDescriptor[] = [];
  let dropped = 0;
  for (const { tool } of weighted) {
    const candidate = [...kept, tool];
    if (canonicalJson(candidate).length > PER_SERVER_MANIFEST_BYTE_CAP) {
      dropped += 1;
      continue;
    }
    kept.push(tool);
  }
  // Never return empty: if even the single lightest tool is over the cap,
  // keep it anyway. An over-cap-but-present tool is recoverable downstream
  // (the loop's own truncation still applies); an empty manifest makes the
  // whole server vanish from the palette with no signal to the model.
  if (kept.length === 0 && weighted[0]) {
    kept.push(weighted[0].tool);
    dropped = tools.length - 1;
  }
  logger.warn({
    module: "mcp_client",
    action: "manifest.token_cap_truncated",
    msg: "external MCP tool manifest exceeded per-server token cap; dropped heaviest tools, kept the lightest that fit",
    tenant_id,
    mcp_server_id,
    namespace,
    cap_bytes: PER_SERVER_MANIFEST_BYTE_CAP,
    original_tool_count: tools.length,
    kept_tool_count: kept.length,
    dropped_tool_count: dropped,
  });
  return kept;
}

function backoffWindow(failures: number): number {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  return Date.now() + delay;
}

/**
 * Resolve the `Authorization` header (if any) for a server's auth_config,
 * reading secrets by reference from the AES-256-GCM credentials table.
 * For oauth2, if the cached access token is expired and a refresh token +
 * issuer are present, runs a refresh-token grant first. Returns the
 * header map to mount on the transport's `requestInit`, or `{}` for none.
 */
async function resolveAuthHeaders(
  db: Db,
  tenant_id: string,
  mcp_server_id: string,
  auth: McpServerAuthConfig,
  environment: "dev" | "prod",
): Promise<Record<string, string>> {
  if (auth.kind === "none") return {};

  const resolved = await getCredentialForMcpServer(tenant_id, mcp_server_id, environment, db);
  if (!resolved) {
    throw new Error(
      `auth_config.kind '${auth.kind}' references a credential that does not exist for this server`,
    );
  }
  const { value } = resolved;

  if (auth.kind === "bearer") {
    if (value.mode !== "bearer") {
      throw new Error(`expected bearer credential for server, got mode '${value.mode}'`);
    }
    return { Authorization: `Bearer ${value.token}` };
  }

  // oauth2
  if (value.mode !== "oauth2") {
    throw new Error(`expected oauth2 credential for server, got mode '${value.mode}'`);
  }
  let accessToken = value.access_token;
  if (isTokenExpired({ expires_at: value.expires_at }) && value.refresh_token && auth.issuer) {
    const bundle = await runRefreshTokenGrant(
      {
        issuer_url: auth.issuer,
        client_id: auth.client_id ?? "",
        scope: auth.scope,
      },
      value.refresh_token,
    );
    accessToken = bundle.access_token;
    // Persist the rotated bundle back to the credentials row keyed by this
    // mcp_server. The connector refresh-worker skips mcp-owned rows, so if
    // we don't write it here a rotating-refresh-token IdP (one that issues
    // a fresh refresh_token on every grant and invalidates the old one)
    // breaks after a single handshake. `rotateOAuth2Tokens` is the same
    // upsert the connector OAuth refresh path uses; we feed the credential
    // id `getCredentialForMcpServer` resolved. Carry the prior refresh
    // token forward when the IdP did not return a new one (non-rotating
    // IdPs omit it), so we never wipe a still-valid refresh token.
    await rotateOAuth2Tokens(
      {
        tenant_id,
        credential_id: resolved.row.id,
        access_token: bundle.access_token,
        token_type: bundle.token_type,
        scope: bundle.scope ?? undefined,
        refresh_token: bundle.refresh_token ?? value.refresh_token,
        expires_at: bundle.expires_at,
        actor_id: null,
      },
      db,
    );
  }
  return { Authorization: `Bearer ${accessToken}` };
}

function buildTransport(
  tenant_id: string,
  row: McpServerRow,
  headers: Record<string, string>,
): StreamableHTTPClientTransport | SSEClientTransport {
  const url = new URL(row.url);
  // SSRF / egress guard at the connection boundary: block loopback,
  // link-local, RFC1918, and cloud-metadata (169.254.169.254) targets
  // before any bytes (carrying the tenant's resolved bearer/OAuth header)
  // leave the host. Registration also guards the URL, but a row could have
  // been seeded out-of-band or the guard mode tightened since; this is the
  // last gate before connect. Throws EgressBlockedError, caught by
  // connectClient's handler which parks the server in backoff.
  assertEgressAllowed(url, { tenant_id });
  const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {};
  switch (row.transport) {
    case "http":
      return new StreamableHTTPClientTransport(url, { requestInit });
    case "sse":
      return new SSEClientTransport(url, {
        requestInit,
        eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers }) },
      });
    case "stdio":
      // stdio spawns a local subprocess; not a v1 transport for a
      // multi-tenant hosted engine (no sandbox, no per-tenant fs).
      throw new Error("stdio transport is not supported for external MCP servers in v1");
    default: {
      const exhaustive: never = row.transport;
      throw new Error(`unknown transport: ${String(exhaustive)}`);
    }
  }
}

/**
 * Connect (or reconnect) a single server: build the transport, resolve
 * auth by reference, handshake, list tools, hash + cap the manifest,
 * reconcile drift, persist handshake state, and audit. On failure parks
 * the server in `error` status and arms exponential backoff. Returns the
 * live PooledClient, or null if the connect failed.
 */
async function connectClient(
  db: Db,
  tenant_id: string,
  row: McpServerRow,
  environment: "dev" | "prod",
  requestSource: RequestSource,
): Promise<PooledClient | null> {
  const bucket = tenantBucket(tenant_id);
  try {
    const auth = parseAuthConfig(row.auth_config ?? null);
    const headers = await resolveAuthHeaders(db, tenant_id, row.id, auth, environment);
    const transport = buildTransport(tenant_id, row, headers);
    const client = new Client({ name: "subkit-mcp-client", version: "1" });
    // The concrete transport classes implement `Transport`; the cast
    // satisfies `exactOptionalPropertyTypes`, where the class's optional
    // `requestInit?` props don't structurally widen to the interface's.
    await client.connect(transport as Transport);

    const listed = await client.listTools();
    const allTools: RemoteToolDescriptor[] = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    const tools = capManifest(tenant_id, row.namespace, row.id, allTools);
    const manifest_hash = hashManifest(tools);

    // Reconcile against the last-observed hash (drift detection + audit).
    // Done before persisting the new handshake state so the previous hash
    // is still on the row when reconcile reads it.
    await reconcileManifestHash({
      db,
      tenant_id,
      mcp_server_id: row.id,
      observed_hash: manifest_hash,
      observed_tool_count: tools.length,
      auditCtx: { actor_id: null, request_source: requestSource },
    });

    await recordMcpServerHandshakeState(db, tenant_id, row.id, manifest_hash);
    await recordMcpServerHandshakeOk({
      tenant_id,
      actor_id: null,
      mcp_server_id: row.id,
      namespace: row.namespace,
      tool_count: tools.length,
      manifest_hash,
      request_source: requestSource,
    });

    const pooled: PooledClient = {
      client,
      namespace: row.namespace,
      mcp_server_id: row.id,
      tools,
      manifest_hash,
      last_heartbeat_at: Date.now(),
      backoff_until: 0,
      consecutive_failures: 0,
    };
    bucket.clients.set(row.id, pooled);
    bucket.backoff.delete(row.id);
    return pooled;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prior =
      bucket.backoff.get(row.id)?.consecutive_failures ??
      bucket.clients.get(row.id)?.consecutive_failures ??
      0;
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
    await setMcpServerStatus(
      db,
      tenant_id,
      row.id,
      "error",
      { actor_id: null, request_source: requestSource },
      { last_error: message },
    );
    logger.warn({
      module: "mcp_client",
      action: "handshake.failed",
      msg: "external MCP server handshake failed; armed backoff",
      tenant_id,
      mcp_server_id: row.id,
      namespace: row.namespace,
      consecutive_failures: failures,
      error: message,
    });
    return null;
  }
}

export interface TenantMcpToolSet {
  namespace: string;
  mcp_server_id: string;
  tools: RemoteToolDescriptor[];
}

/**
 * Lazily connect a tenant's connectable external MCP servers and return
 * their cached tool manifests. A server already cached is reused; one
 * inside a backoff window is skipped; one not yet connected is connected
 * now. Consumed by the loop layer to assemble the merged tool palette.
 *
 * RECOVERY: we enumerate `listConnectableMcpServersForTenant` (active OR
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
  const environment = opts?.environment ?? "prod";
  const requestSource: RequestSource = opts?.requestSource ?? "chat";
  const bucket = tenantBucket(tenant_id);
  const servers = await listConnectableMcpServersForTenant(db, tenant_id);
  const now = Date.now();
  const out: TenantMcpToolSet[] = [];

  for (const row of servers) {
    const cached = bucket.clients.get(row.id);
    if (cached) {
      out.push({
        namespace: cached.namespace,
        mcp_server_id: cached.mcp_server_id,
        tools: cached.tools,
      });
      continue;
    }
    // Respect an armed backoff window: skip this server this turn.
    const window = bucket.backoff.get(row.id);
    if (window && window.backoff_until > now) continue;

    const pooled = await connectClient(db, tenant_id, row, environment, requestSource);
    if (pooled) {
      out.push({
        namespace: pooled.namespace,
        mcp_server_id: pooled.mcp_server_id,
        tools: pooled.tools,
      });
    }
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
 * in `error` + backoff exactly as the palette path does. Returns the live
 * tool set, or null if the server doesn't exist, is disabled, or the
 * handshake failed.
 */
export async function connectServerById(
  db: Db,
  tenant_id: string,
  mcp_server_id: string,
  opts?: { environment?: "dev" | "prod"; requestSource?: RequestSource },
): Promise<TenantMcpToolSet | null> {
  const environment = opts?.environment ?? "prod";
  const requestSource: RequestSource = opts?.requestSource ?? "chat";
  const row = await getMcpServer(db, tenant_id, mcp_server_id);
  if (!row || row.status === "disabled") return null;
  // Clear any armed backoff so the operator's inspect is honoured now.
  tenantBucket(tenant_id).backoff.delete(mcp_server_id);
  const pooled = await connectClient(db, tenant_id, row, environment, requestSource);
  if (!pooled) return null;
  return {
    namespace: pooled.namespace,
    mcp_server_id: pooled.mcp_server_id,
    tools: pooled.tools,
  };
}

export interface InvokeRemoteToolInput {
  db: Db;
  tenant_id: string;
  mcp_server_id: string;
  namespace: string;
  remote_tool: string;
  input: Record<string, unknown>;
  environment?: "dev" | "prod";
  requestSource?: RequestSource;
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
  bytes: number;
}

/**
 * Invoke a tool on a tenant's already-connected external MCP server.
 * Returns the FULL, verbatim remote content (the caller persists it for
 * determinism and derives the truncated model view itself). The remote
 * call is bounded by `REMOTE_TOOL_CALL_TIMEOUT_MS`; on timeout / transport
 * error the result is `ok:false` with a tool error and the (now likely
 * dead) pooled client is evicted so the next turn reconnects.
 */
export async function invokeRemoteTool(
  args: InvokeRemoteToolInput,
): Promise<InvokeRemoteToolResult> {
  const environment = args.environment ?? "prod";
  const requestSource: RequestSource = args.requestSource ?? "chat";
  const bucket = tenantBucket(args.tenant_id);
  let pooled = bucket.clients.get(args.mcp_server_id);
  if (!pooled) {
    // Lazily (re)connect on demand if the palette was assembled in a prior
    // turn that didn't warm this server. Enumerate connectable rows (active
    // OR error) so an error-status server past its backoff is still
    // invokable rather than permanently dark.
    const servers = await listConnectableMcpServersForTenant(args.db, args.tenant_id);
    const row = servers.find((s) => s.id === args.mcp_server_id);
    if (!row) {
      return { ok: false, content: { error: "mcp_server not found or not active" }, bytes: 0 };
    }
    pooled =
      (await connectClient(args.db, args.tenant_id, row, environment, requestSource)) ?? undefined;
    if (!pooled) {
      return { ok: false, content: { error: "mcp_server handshake failed" }, bytes: 0 };
    }
  }

  const started = Date.now();
  let outcome: "success" | "error" = "success";
  let transportFailed = false;
  let content: unknown;
  try {
    // Bounded timeout via the SDK RequestOptions. Without it a hung remote
    // never returns and the held toolChain mutex wedges the entire turn.
    const res = await pooled.client.callTool(
      {
        name: args.remote_tool,
        arguments: args.input,
      },
      undefined,
      { timeout: REMOTE_TOOL_CALL_TIMEOUT_MS },
    );
    content = res.content;
    if (res.isError) outcome = "error";
    pooled.last_heartbeat_at = Date.now();
  } catch (err) {
    // A timeout or transport error means the socket is likely dead. Surface
    // a tool error (never throw out of the turn) and EVICT the pooled
    // client so the next invoke reconnects instead of re-failing forever
    // against a stale connection.
    outcome = "error";
    transportFailed = true;
    content = { error: err instanceof Error ? err.message : String(err) };
  }

  // Raw byte count for the audit metadata (bucketed there). The content is
  // returned VERBATIM — truncation of the model-facing view is the caller's
  // job (truncateForLlm), so the persisted raw payload stays intact for
  // get_raw_result / replay determinism.
  const serialized = (() => {
    try {
      return JSON.stringify(content) ?? "";
    } catch {
      return "";
    }
  })();
  const rawBytes = Buffer.byteLength(serialized, "utf8");

  if (transportFailed) {
    invalidateCachedManifest(args.tenant_id, args.mcp_server_id);
  }

  await recordMcpExternalToolInvoked({
    tenant_id: args.tenant_id,
    actor_id: null,
    mcp_server_id: args.mcp_server_id,
    namespace: args.namespace,
    remote_tool: args.remote_tool,
    outcome,
    duration_ms: Date.now() - started,
    byte_count: rawBytes,
    request_source: requestSource,
  });

  return { ok: outcome === "success", content, bytes: rawBytes };
}

/** Drop + close every Client for a tenant. Called on disable/delete so a
 *  removed server stops being reachable and its credential header is no
 *  longer held in memory. */
export function evictTenant(tenant_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  for (const pooled of bucket.clients.values()) {
    void pooled.client.close().catch(() => {});
  }
  POOL.delete(tenant_id);
}

/** Drop the cached manifest (and live Client) for a single server so the
 *  next `getTenantMcpTools` re-lists tools. Called by the schema-drift
 *  reconciler when the remote manifest changed. */
export function invalidateCachedManifest(tenant_id: string, mcp_server_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  const pooled = bucket.clients.get(mcp_server_id);
  if (pooled) {
    bucket.clients.delete(mcp_server_id);
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
