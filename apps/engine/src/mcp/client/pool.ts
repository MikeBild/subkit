import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { backoffDelay } from "@shared/backoff.ts";
import { classifyMcpToolSideEffect, type SideEffect } from "@shared/index.ts";
import {
  recordConnectorMcpHandshakeOk,
  recordMcpExternalToolInvoked,
} from "../../audit/recorders/index.ts";
import type { AuditActorType } from "../../audit/types.ts";
import { getConfig } from "../../config/loader.ts";
import type { CredentialUseSnapshot } from "../../credentials/index.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { withMcpCredentialObserver } from "./credential-observation.ts";
import {
  capManifest,
  hashManifest,
  listAllRemoteTools,
  PER_SERVER_MANIFEST_BYTE_CAP,
  parseRemoteManifest,
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

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const REMOTE_TOOL_CALL_TIMEOUT_MS = 30_000;

function remoteToolCallTimeoutMs(tenant_id: string): number {
  try {
    return getConfig(tenant_id).connectors.mcp.remote_tool_call_timeout_ms;
  } catch {
    return REMOTE_TOOL_CALL_TIMEOUT_MS;
  }
}

export type { RemoteToolDescriptor } from "./manifest.ts";
export type {
  McpClientLike,
  NegotiatedServerCapabilities,
  ServerCapabilitiesLike,
} from "./session.ts";

type McpPoolTestFactories = McpSessionFactories;

export function __setMcpPoolFactoriesForTests(f: McpPoolTestFactories | null): void {
  setMcpSessionFactoriesForTests(f);
}

interface PooledClient {
  client: McpClientLike;
  slug: string;
  connector_id: string;
  tools: RemoteToolDescriptor[];
  manifest_hash: string;
  capabilities: NegotiatedServerCapabilities | null;
  server_version: Record<string, unknown> | null;
  instructions: string | null;
  last_heartbeat_at: number;
  backoff_until: number;
  consecutive_failures: number;
}

interface TenantMcpPool {
  clients: Map<string, PooledClient>;
  backoff: Map<string, { backoff_until: number; consecutive_failures: number }>;
}

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
  return (
    Date.now() + backoffDelay(failures - 1, 1, { baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS })
  );
}

type ConnectClientOutcome = { pooled: PooledClient } | { pooled: null; error: string };

type McpAuditActor = { actor_id: string | null; actor_type?: AuditActorType };

async function connectClient(
  db: Db,
  tenant_id: string,
  row: McpConnectorRow,
  environment: "dev" | "prod",
  requestSource: RequestSource,
  actor: McpAuditActor = { actor_id: null },
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

    await reconcileManifestHash({
      db,
      tenant_id,
      connector_id: row.id,
      connector_slug: row.slug,
      observed_hash: manifest_hash,
      observed_tool_count: tools.length,
      auditCtx: { ...actor, request_source: requestSource, executor: db },
    });

    await recordMcpHandshakeState(db, row, manifest_hash);
    await recordMcpNegotiation(db, row, {
      protocol_version: readNegotiatedProtocolVersion(),
      server_capabilities: (client.getServerCapabilities?.() ?? null) as Record<
        string,
        unknown
      > | null,
    });
    await recordConnectorMcpHandshakeOk({
      tenant_id,
      ...actor,
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
    const message =
      err instanceof UnauthorizedError
        ? UNAUTHORIZED_HANDSHAKE_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err);
    const prior = bucket.backoff.get(row.id)?.consecutive_failures ?? 0;
    const failures = prior + 1;
    bucket.backoff.set(row.id, {
      consecutive_failures: failures,
      backoff_until: backoffWindow(failures),
    });
    const stale = bucket.clients.get(row.id);
    if (stale) {
      bucket.clients.delete(row.id);
      void stale.client.close().catch(() => {});
    }
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
    return { pooled: null, error: redactUpstreamDetail(message) };
  }
}

type TransientMcpProbeOutcome =
  | {
      ok: true;
      tool_count: number;
      manifest_hash: string;
      tools: RemoteToolDescriptor[];
      instructions: string | null;
    }
  | { ok: false; detail: string; preflight_error_code?: McpPreflightErrorCode };

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
      tools: opened.tools,
      instructions: opened.instructions,
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
  display_name: string;
  url: string;
  tools: RemoteToolDescriptor[];
  capabilities: NegotiatedServerCapabilities | null;
  instructions: string | null;
  server_version: Record<string, unknown> | null;
}

function toolSetOf(pooled: PooledClient, row: McpConnectorRow): TenantMcpToolSet {
  return {
    slug: pooled.slug,
    connector_id: pooled.connector_id,
    display_name: row.display_name,
    url: row.url,
    tools: pooled.tools,
    capabilities: pooled.capabilities,
    instructions: pooled.instructions,
    server_version: pooled.server_version,
  };
}

export async function getTenantMcpTools(
  db: Db,
  tenant_id: string,
  opts?: {
    environment?: "dev" | "prod";
    requestSource?: RequestSource;
    actor_id?: string | null;
    actor_type?: AuditActorType;
    connector_ids?: readonly string[];
  },
): Promise<TenantMcpToolSet[]> {
  const environment = opts?.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
  const requestSource: RequestSource = opts?.requestSource ?? "chat";
  const bucket = tenantBucket(tenant_id);
  const only = opts?.connector_ids;
  const servers = (await listConnectableMcpConnectorsForTenant(db, tenant_id)).filter(
    (row) => !only || only.includes(row.id),
  );
  const now = Date.now();
  const out: TenantMcpToolSet[] = [];

  for (const row of servers) {
    const cached = bucket.clients.get(row.id);
    if (cached) {
      out.push(toolSetOf(cached, row));
      continue;
    }
    const window = bucket.backoff.get(row.id);
    if (window && window.backoff_until > now) continue;
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

    const outcome = await connectClient(db, tenant_id, row, environment, requestSource, {
      actor_id: opts?.actor_id ?? null,
      ...(opts?.actor_type ? { actor_type: opts.actor_type } : {}),
    });
    if (outcome.pooled) out.push(toolSetOf(outcome.pooled, row));
  }
  return out;
}

type ConnectServerOutcome =
  | { ok: true; tools: TenantMcpToolSet }
  | { ok: false; reason: "not_found" | "disabled" | "handshake_failed"; detail: string | null };

export async function connectServerById(
  db: Db,
  tenant_id: string,
  connector_id: string,
  opts?: {
    environment?: "dev" | "prod";
    requestSource?: RequestSource;
    actor_id?: string | null;
    actor_type?: AuditActorType;
  },
): Promise<ConnectServerOutcome> {
  const environment = opts?.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
  const requestSource: RequestSource = opts?.requestSource ?? "chat";
  const row = await getMcpConnector(db, tenant_id, connector_id);
  if (!row) return { ok: false, reason: "not_found", detail: null };
  if (!row.enabled) return { ok: false, reason: "disabled", detail: null };
  tenantBucket(tenant_id).backoff.delete(connector_id);
  const outcome = await connectClient(db, tenant_id, row, environment, requestSource, {
    actor_id: opts?.actor_id ?? null,
    ...(opts?.actor_type ? { actor_type: opts.actor_type } : {}),
  });
  if (!outcome.pooled) {
    return { ok: false, reason: "handshake_failed", detail: outcome.error };
  }
  return { ok: true, tools: toolSetOf(outcome.pooled, row) };
}

export interface InvokeRemoteToolInput {
  before_call?: (tool: RemoteToolDescriptor | null) => Promise<void>;
  on_dispatch?: () => void;
  on_credential_use?: (snapshot: CredentialUseSnapshot) => Promise<void>;
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  actor_type?: AuditActorType;
  connector_id: string;
  connector_slug: string;
  call: RemoteCall;
  environment?: "dev" | "prod";
  requestSource?: RequestSource;
  timeout_ms?: number;
  signal?: AbortSignal;
  onProgress?: (p: { progress: number; total?: number; message?: string }) => void;
  gate_rule?: "connector_trust";
}

export interface InvokeRemoteToolResult {
  ok: boolean;
  content: unknown;
  structured_content?: unknown;
  bytes: number;
  failure: "not_connected" | "transport" | "remote_error" | "cancelled" | null;
}

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

export async function pooledToolDescriptors(args: {
  db: Db;
  tenant_id: string;
  connector_id: string;
  environment?: "dev" | "prod";
  requestSource?: RequestSource;
  fresh?: boolean;
}): Promise<RemoteToolDescriptor[] | null> {
  const pooled = tenantBucket(args.tenant_id).clients.get(args.connector_id);
  if (pooled && !args.fresh) return pooled.tools;
  if (pooled) {
    try {
      const raw =
        pooled.capabilities && !pooled.capabilities.tools
          ? []
          : await listAllRemoteTools(
              args.tenant_id,
              pooled.slug,
              pooled.connector_id,
              pooled.client,
            );
      const tools = capManifest(
        args.tenant_id,
        pooled.slug,
        pooled.connector_id,
        parseRemoteManifest(raw).tools,
      );
      pooled.tools = tools;
      pooled.manifest_hash = hashManifest(tools);
      return tools;
    } catch {
      return null;
    }
  }
  const backoff = tenantBucket(args.tenant_id).backoff.get(args.connector_id);
  if (backoff && backoff.backoff_until > Date.now()) return null;
  const servers = await listConnectableMcpConnectorsForTenant(args.db, args.tenant_id);
  const row = servers.find((server) => server.id === args.connector_id);
  if (!row) return null;
  const outcome = await connectClient(
    args.db,
    args.tenant_id,
    row,
    args.environment ?? MCP_CREDENTIAL_ENVIRONMENT,
    args.requestSource ?? "api",
    { actor_id: null },
  );
  return outcome.pooled?.tools ?? null;
}

export function invokeRemoteTool(args: InvokeRemoteToolInput): Promise<InvokeRemoteToolResult> {
  return withMcpCredentialObserver(args.on_credential_use, () => invokeRemoteToolWithContext(args));
}

async function invokeRemoteToolWithContext(
  args: InvokeRemoteToolInput,
): Promise<InvokeRemoteToolResult> {
  const environment = args.environment ?? MCP_CREDENTIAL_ENVIRONMENT;
  const requestSource: RequestSource = args.requestSource ?? "chat";
  const bucket = tenantBucket(args.tenant_id);
  let pooled = bucket.clients.get(args.connector_id);
  if (!pooled) {
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
    const outcome = await connectClient(args.db, args.tenant_id, row, environment, requestSource, {
      actor_id: args.actor_id,
      ...(args.actor_type ? { actor_type: args.actor_type } : {}),
    });
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

  if (args.before_call) {
    const call = args.call;
    await args.before_call(
      call.operation === "call_tool"
        ? (pooled.tools.find((tool) => tool.name === call.tool) ?? null)
        : null,
    );
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
    args.on_dispatch?.();
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
    failure = classifyCallFailure(err, args.signal);
    outcome = failure === "cancelled" ? "cancelled" : "error";
    transportFailed = failure === "transport";
    unauthorized = transportFailed && isUnauthorized(err);
    content = { error: err instanceof Error ? err.message : String(err) };
  }

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
    ...(args.actor_type ? { actor_type: args.actor_type } : {}),
    connector_id: args.connector_id,
    connector_slug: args.connector_slug,
    remote_tool: remoteCallTarget(args.call),
    operation: MCP_WIRE_METHOD[args.call.operation],
    outcome,
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

function advertisedSideEffect(pooled: PooledClient, call: RemoteCall): SideEffect | null {
  if (call.operation !== "call_tool") return null;
  const descriptor = pooled.tools.find((t) => t.name === call.tool);
  if (!descriptor?.annotations) return null;
  return classifyMcpToolSideEffect(descriptor.annotations);
}

export function evictTenant(tenant_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  for (const pooled of bucket.clients.values()) {
    void pooled.client.close().catch(() => {});
  }
  POOL.delete(tenant_id);
}

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

export function invalidateCachedManifest(tenant_id: string, connector_id: string): void {
  const bucket = POOL.get(tenant_id);
  if (!bucket) return;
  const pooled = bucket.clients.get(connector_id);
  if (pooled) {
    bucket.clients.delete(connector_id);
    void pooled.client.close().catch(() => {});
  }
}

export function __resetMcpClientPoolForTests(): void {
  for (const bucket of POOL.values()) {
    for (const pooled of bucket.clients.values()) {
      void pooled.client.close().catch(() => {});
    }
  }
  POOL.clear();
}

export const __mcpClientInternalsForTests = {
  hashManifest,
  capManifest,
  PER_SERVER_MANIFEST_BYTE_CAP,
  REMOTE_TOOL_CALL_TIMEOUT_MS,
};
