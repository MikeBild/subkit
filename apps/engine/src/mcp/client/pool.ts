// Per-tenant external MCP Client pool.
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
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ClientCredentialsProvider,
  PrivateKeyJwtProvider,
} from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  recordMcpExternalToolInvoked,
  recordMcpServerHandshakeOk,
} from "../../audit/recorders/index.ts";
import { getConfig } from "../../config/loader.ts";
import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import { assertEgressAllowed } from "../../connectors/egress-guard.ts";
import {
  getCredentialForMcpServer,
  getOAuth2ClientCredentialForMcpServer,
  getOAuth2PrivateKeyCredentialForMcpServer,
} from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { McpDbOAuthClientProvider } from "./oauth-provider.ts";
import { buildMcpOAuthRedirectUri } from "./oauth-redirect.ts";
import {
  getMcpServer,
  listConnectableMcpServersForTenant,
  MCP_CREDENTIAL_ENVIRONMENT,
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
// context window on their own. DEFAULT for the tenant-scoped
// `mcp.client.per_server_manifest_byte_cap` config leaf (read at use via
// `manifestByteCap`); the schema default mirrors this value.
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
// DEFAULT for the tenant-scoped `mcp.client.remote_tool_call_timeout_ms`
// config leaf (read at use via `remoteToolCallTimeoutMs`); the schema
// default mirrors this value.
const REMOTE_TOOL_CALL_TIMEOUT_MS = 30_000;

/** Effective per-server manifest byte cap for a tenant. Falls back to the
 *  module default when the config loader is not initialised (unit tests) —
 *  same guard pattern as loop.ts's `webSearchSetting`. */
function manifestByteCap(tenant_id: string): number {
  try {
    return getConfig(tenant_id).mcp.client.per_server_manifest_byte_cap;
  } catch {
    return PER_SERVER_MANIFEST_BYTE_CAP;
  }
}

/** Effective remote `tools/call` timeout for a tenant. Falls back to the
 *  module default when the config loader is not initialised (unit tests). */
function remoteToolCallTimeoutMs(tenant_id: string): number {
  try {
    return getConfig(tenant_id).mcp.client.remote_tool_call_timeout_ms;
  } catch {
    return REMOTE_TOOL_CALL_TIMEOUT_MS;
  }
}

/** A remote tool, reduced to the fields the loop layer needs to convert
 *  it into an AI SDK `Tool`. `ai@6` ships no `createMCPClient`, so the
 *  loop does that conversion by hand from this descriptor. */
export interface RemoteToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── TEST SEAM ────────────────────────────────────────────────────────────────
// Overrides the SDK client/transport construction inside `connectClient`.
// Production never sets this; tests inject in-process fakes WITHOUT bun's
// `mock.module` (module mocks are process-global and leak into every other
// test file that builds an SDK Client in the same worker). Null by default,
// so even a missed restore can never alter production behavior — but tests
// MUST still restore null in afterAll so a fake doesn't bleed into sibling
// test files that also set the seam.

/** Structural slice of the SDK `Client` the pool actually uses. */
export interface McpClientLike {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string | undefined; inputSchema: unknown }>;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<{ [key: string]: unknown; content?: unknown; isError?: unknown }>;
  close(): Promise<void>;
}

export interface McpPoolTestFactories {
  /** Replaces `new Client(...)`. Receives the server row so a fake can
   *  branch per server (URL / namespace) without touching the transport. */
  makeClient?: (row: McpServerRow) => McpClientLike;
  /** Replaces `buildTransport(...)` (including its egress guard — the guard
   *  has its own dedicated tests). */
  makeTransport?: (row: McpServerRow, headers: Record<string, string>) => Transport;
}

let testFactories: McpPoolTestFactories | null = null;

export function __setMcpPoolFactoriesForTests(f: McpPoolTestFactories | null): void {
  testFactories = f;
}

interface PooledClient {
  client: McpClientLike;
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
  // Per-tenant cap from `mcp.client.per_server_manifest_byte_cap`; the
  // same value drives the admission loop and the log line below.
  const effectiveCapBytes = manifestByteCap(tenant_id);
  if (canonicalJson(tools).length <= effectiveCapBytes) return tools;
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
    if (canonicalJson(candidate).length > effectiveCapBytes) {
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
    cap_bytes: effectiveCapBytes,
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
 * Resolve the static `Authorization` header (if any) for a server's
 * auth_config, reading the secret by reference from the AES-256-GCM
 * credentials table. Handles ONLY the static-header kinds — `none` (empty),
 * `bearer`, and `basic`. The `oauth2` kind is NOT resolved here: it is
 * driven end to end by the SDK transport's `authProvider` (see
 * `McpDbOAuthClientProvider`), which owns token replay, pre-expiry
 * refresh, and persistence. Returns the header map to mount on the
 * transport's `requestInit`, or `{}` for none.
 */
async function resolveAuthHeaders(
  db: Db,
  tenant_id: string,
  mcp_server_id: string,
  auth: McpServerAuthConfig,
  environment: "dev" | "prod",
): Promise<Record<string, string>> {
  if (auth.kind === "none") return {};
  // oauth2 / M2M kinds carry no static header — the authProvider supplies
  // the token via the SDK's non-interactive fetch path.
  if (
    auth.kind === "oauth2" ||
    auth.kind === "oauth2_client_credentials" ||
    auth.kind === "oauth2_private_key_jwt"
  )
    return {};

  const resolved = await getCredentialForMcpServer(tenant_id, mcp_server_id, environment, db);
  if (!resolved) {
    throw new Error(
      `auth_config.kind '${auth.kind}' references a credential that does not exist for this server`,
    );
  }
  const { value } = resolved;

  switch (auth.kind) {
    case "bearer": {
      if (value.mode !== "bearer") {
        throw new Error(`expected bearer credential for server, got mode '${value.mode}'`);
      }
      return { Authorization: `Bearer ${value.token}` };
    }
    case "basic": {
      if (value.mode !== "basic") {
        throw new Error(`expected basic credential for server, got mode '${value.mode}'`);
      }
      // RFC 7617 — the userid:password pair, base64. Used by remote MCP
      // servers that accept non-interactive personal API tokens (e.g.
      // Atlassian Rovo: base64(email:api_token)).
      const pair = Buffer.from(`${value.username}:${value.password}`, "utf8").toString("base64");
      return { Authorization: `Basic ${pair}` };
    }
  }
}

/**
 * Canonical OAuth callback URL handed to the (non-interactive) handshake
 * provider as its `redirect_uri`. The palette handshake never opens a
 * browser or runs a code exchange, so this value is only used to populate
 * the SDK's `clientMetadata.redirect_uris` on a DCR (RFC 7591) registration.
 *
 * CRITICAL (redirect_uri parity): this MUST be byte-identical to the value
 * the interactive authorize route registers (both go through
 * `buildMcpOAuthRedirectUri` → `MCP_OAUTH_CALLBACK_PATH`). If the pool's DCR
 * registered any other redirect_uri while the authorize flow used the MCP
 * callback, the IdP would reject the authorization request with
 * `redirect_uri_mismatch`. There is deliberately NO fallback when no public
 * origin is configured: the interactive /authorize route 400s in the same
 * condition, so a fallback here would DCR-register a redirect_uri the
 * authorize flow can never use — a permanent `redirect_uri_mismatch`.
 * Instead we throw; `connectClient`'s catch parks the server in
 * error+backoff with this message as its redact-safe `last_error`, the
 * same degradation as any other handshake failure.
 */
function oauthRedirectUriFor(): string {
  const canonical = buildMcpOAuthRedirectUri();
  if (canonical) return canonical;
  throw new Error("no canonical OAuth redirect URI — set server.public_base_url");
}

/** Detect an Unauthorized/401 from a remote tool call. Matches both the
 *  SDK's typed `UnauthorizedError` and a generic 401 surfaced as a message
 *  (some transports raise a plain Error carrying the HTTP status). */
function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  if (err instanceof Error) {
    if (err.name === "UnauthorizedError") return true;
    if (/\b401\b|\bunauthorized\b/i.test(err.message)) return true;
  }
  return false;
}

/**
 * Drop the oauth2 access/refresh token credential for a server after a
 * mid-session 401, so the next handshake re-authorizes instead of replaying
 * the dead token. No-op for non-oauth2 servers (no token to invalidate) or
 * a vanished server row. Tenant/server-scoped via the provider's own
 * tenant-filtered delete.
 */
async function invalidateOAuth2TokenForServer(
  db: Db,
  tenant_id: string,
  mcp_server_id: string,
  environment: "dev" | "prod",
  requestSource: RequestSource,
): Promise<void> {
  const row = await getMcpServer(db, tenant_id, mcp_server_id);
  if (!row) return;
  const auth = parseAuthConfig(row.auth_config ?? null);
  if (auth.kind !== "oauth2") return;
  const provider = new McpDbOAuthClientProvider({
    db,
    tenant_id,
    mcp_server_id,
    environment,
    // Reaching a mid-session 401 implies this oauth2 server connected in
    // this process, which requires the canonical redirect URI to resolve —
    // so this cannot throw here (config is fixed for the process lifetime).
    redirect_uri: oauthRedirectUriFor(),
    state: "",
    auth,
    interactive: false,
    request_source: requestSource,
  });
  await provider.invalidateCredentials("tokens");
  logger.warn({
    module: "mcp_client",
    action: "tool.invoke.token_invalidated",
    msg: "external MCP tool call returned 401; invalidated oauth2 token so the next handshake re-authorizes",
    tenant_id,
    mcp_server_id,
    namespace: row.namespace,
  });
}

function buildTransport(
  tenant_id: string,
  row: McpServerRow,
  headers: Record<string, string>,
  authProvider?: OAuthClientProvider,
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
      return new StreamableHTTPClientTransport(url, {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
      });
    case "sse":
      return new SSEClientTransport(url, {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
        eventSourceInit: { fetch: (u, init) => getDriverFetch()(u, { ...init, headers }) },
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
 * Resolve the SDK `OAuthClientProvider` for a server row, or `undefined`
 * when the auth kind uses a static header (bearer / basic / none).
 *
 * - `oauth2` → `McpDbOAuthClientProvider` in non-interactive mode (no
 *   browser, no code exchange; a missing token surfaces as
 *   `UnauthorizedError` on connect and is caught by `connectClient`).
 * - `oauth2_client_credentials` → SDK `ClientCredentialsProvider`. Reads
 *   the client_id + client_secret from the `oauth2_client` credential
 *   slot (same slot used by the interactive oauth2 path). If absent →
 *   throws a clear error (caught → parked in error+backoff).
 * - `oauth2_private_key_jwt` → SDK `PrivateKeyJwtProvider`. Reads the
 *   client_id, private_key, and algorithm from the `oauth2_private_key`
 *   credential slot. If absent → throws (caught → parked).
 *
 * Both M2M providers discover the token endpoint via RFC 9728 off
 * `row.url` — the `issuer` field in `auth_config` is documentation-only.
 * Both cache their access token in-memory (no `saveTokens` persistence);
 * only the long-lived secret (client_secret / private_key) is stored
 * encrypted in `credentials`.
 */
async function resolveAuthProvider(
  db: Db,
  tenant_id: string,
  row: McpServerRow,
  auth: McpServerAuthConfig,
  environment: "dev" | "prod",
  requestSource: RequestSource,
): Promise<OAuthClientProvider | undefined> {
  switch (auth.kind) {
    case "oauth2":
      return new McpDbOAuthClientProvider({
        db,
        tenant_id,
        mcp_server_id: row.id,
        environment,
        // Throws when no canonical redirect URI is configured — caught
        // by connectClient and parked as a redact-safe last_error + backoff.
        redirect_uri: oauthRedirectUriFor(),
        // No mcp_oauth_states row exists for the palette handshake; the
        // state value is unused in non-interactive mode.
        state: "",
        auth,
        interactive: false,
        request_source: requestSource,
      });

    case "oauth2_client_credentials": {
      // Read the client_secret from the `oauth2_client` credential slot,
      // which is where the route handler writes it (same slot as DCR
      // for the interactive oauth2 path).
      const cred = await getOAuth2ClientCredentialForMcpServer(tenant_id, row.id, environment, db);
      if (cred == null) {
        throw new Error(
          "oauth2_client_credentials server has no client credential — register the client_id and client_secret first",
        );
      }
      if (!cred.client_secret) {
        throw new Error("oauth2_client_credentials server credential is missing client_secret");
      }
      return new ClientCredentialsProvider({
        clientId: cred.client_id,
        clientSecret: cred.client_secret,
        ...(auth.scope ? { scope: auth.scope } : {}),
      });
    }

    case "oauth2_private_key_jwt": {
      // Read the private_key + algorithm from the `oauth2_private_key`
      // credential slot (distinct from the `oauth2_client` slot).
      const cred = await getOAuth2PrivateKeyCredentialForMcpServer(
        tenant_id,
        row.id,
        environment,
        db,
      );
      if (cred == null) {
        throw new Error(
          "oauth2_private_key_jwt server has no private key credential — register the client_id, private_key, and algorithm first",
        );
      }
      return new PrivateKeyJwtProvider({
        clientId: cred.client_id,
        privateKey: cred.private_key,
        algorithm: cred.algorithm,
        ...(auth.scope ? { scope: auth.scope } : {}),
      });
    }

    default:
      // bearer / basic / none — no provider; static header path.
      return undefined;
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
    // For oauth2 / M2M kinds the SDK transport's authProvider owns the whole
    // token lifecycle. bearer/basic/none keep the static header instead.
    //
    // oauth2 (interactive): constructs McpDbOAuthClientProvider in
    //   non-interactive mode — redirectToAuthorization no-ops, so no
    //   browser opens. A missing/expired token raises UnauthorizedError
    //   on connect, caught below and parked in backoff.
    //
    // oauth2_client_credentials (M2M): constructs ClientCredentialsProvider.
    //   The SDK fetches the token directly via RFC 9728 discovery on row.url.
    //   Token is cached in-memory on the provider instance (not persisted).
    //
    // oauth2_private_key_jwt (M2M): constructs PrivateKeyJwtProvider.
    //   Same non-interactive discovery path; signs each token request with
    //   the stored private key.
    const authProvider: OAuthClientProvider | undefined = await resolveAuthProvider(
      db,
      tenant_id,
      row,
      auth,
      environment,
      requestSource,
    );
    // TEST SEAM consumption (see header above `McpPoolTestFactories`):
    // production always takes the `??` fallback — real transport, real Client.
    const transport =
      testFactories?.makeTransport?.(row, headers) ??
      buildTransport(tenant_id, row, headers, authProvider);
    const client: McpClientLike =
      testFactories?.makeClient?.(row) ?? new Client({ name: "subkit-mcp-client", version: "1" });
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
      auditCtx: { actor_id: null, request_source: requestSource, executor: db },
    });

    await recordMcpServerHandshakeState(db, tenant_id, row.id, manifest_hash, {
      actor_id: null,
      request_source: requestSource,
      executor: db,
    });
    await recordMcpServerHandshakeOk({
      tenant_id,
      actor_id: null,
      mcp_server_id: row.id,
      namespace: row.namespace,
      tool_count: tools.length,
      manifest_hash,
      request_source: requestSource,
      executor: db,
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
        ? "authorization required"
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
    await setMcpServerStatus(
      db,
      tenant_id,
      row.id,
      "error",
      { actor_id: null, request_source: requestSource, executor: db },
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
  const environment = opts?.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
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
  const environment = opts?.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
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
  /** Principal that drove this invocation (chat user / system account),
   *  or null for a genuinely actor-less system path. Threaded into the
   *  `mcp_external_tool.invoked` audit row so a real user's invocation is
   *  attributed to that user, not blurred into a system actor. */
  actor_id: string | null;
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
  const environment = args.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
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
  let unauthorized = false;
  let content: unknown;
  try {
    // Bounded timeout via the SDK RequestOptions. Without it a hung remote
    // never returns and the held toolChain mutex wedges the entire turn.
    // Per-tenant value from `mcp.client.remote_tool_call_timeout_ms`.
    const res = await pooled.client.callTool(
      {
        name: args.remote_tool,
        arguments: args.input,
      },
      undefined,
      { timeout: remoteToolCallTimeoutMs(args.tenant_id) },
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
    unauthorized = isUnauthorized(err);
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
        args.mcp_server_id,
        environment,
        requestSource,
      );
    }
  }

  await recordMcpExternalToolInvoked({
    tenant_id: args.tenant_id,
    actor_id: args.actor_id,
    mcp_server_id: args.mcp_server_id,
    namespace: args.namespace,
    remote_tool: args.remote_tool,
    outcome,
    duration_ms: Date.now() - started,
    byte_count: rawBytes,
    request_source: requestSource,
    executor: args.db,
  });

  return { ok: outcome === "success", content, bytes: rawBytes };
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
export function evictServer(tenant_id: string, mcp_server_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  const pooled = bucket.clients.get(mcp_server_id);
  if (pooled) {
    bucket.clients.delete(mcp_server_id);
    void pooled.client.close().catch(() => {});
  }
  bucket.backoff.delete(mcp_server_id);
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
