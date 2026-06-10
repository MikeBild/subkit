// External MCP server audit recorders.
//
// Used by the external-MCP-client registry + client pool (#171) to log
// the lifecycle of a registered external MCP server alongside every
// state change. The audit row is the only tenant-visible evidence that
// a privileged change (a new outbound MCP target, an auth_config edit,
// an enable/disable flip) happened.
//
// SECRET-BY-REFERENCE: these recorders MUST NOT carry a full URL with a
// query string, a token, or any auth material. Only the URL *host* is
// recorded (extracted via `urlHost` below, mirroring the
// `issuer_url_host` pattern in credential.ts). The `tools_manifest_hash`
// and `tool_count` are non-secret integrity/sizing signals.
//
// Every row carries `request_source` (CLI vs API vs MCP) in metadata so
// operators can attribute a config change to the surface that drove it,
// and `tenant_id` so the trail stays tenant-scoped.

import type { RequestSource } from "../../observability/service-metadata.ts";
import { auditAwait } from "../audit.ts";
import { bucketSize } from "../buckets.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

/**
 * Reduce an arbitrary URL to just its host so the audit trail never
 * carries a query string, path, token, or secret. Mirrors the
 * `issuer_url_host` extraction in credential.ts. A value that does not
 * parse as a URL (e.g. a stdio command path) is passed through
 * unchanged — there is no host to leak in that case.
 */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface RecordMcpServerRegisteredParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  transport: string;
  /** Already host-only; pass `urlHost(rawUrl)` at the call site if unsure. */
  url_host: string;
  request_source: RequestSource;
}

export async function recordMcpServerRegistered(
  p: RecordMcpServerRegisteredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_REGISTERED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
        transport: p.transport,
        url_host: urlHost(p.url_host),
      },
    },
    p.executor,
  );
}

/**
 * Params for `mcp_server.config_updated`.
 *
 * SIEM DISCRIMINATION (human edit vs. drift): two distinct producers land
 * this same action, told apart by their `changed_fields` + `reason`:
 *   - Operator PATCH edit: `changed_fields` lists the actual columns the
 *     operator changed (e.g. `["url", "auth_config"]`) and `reason` is the
 *     operator's note (or absent).
 *   - Drift-driven update: `changed_fields` is EXACTLY
 *     `["tools_manifest_hash"]` with `reason: "tool_manifest_drift"` —
 *     emitted by the schema-drift reconciler when the remote manifest
 *     changed, NOT by an operator. SIEM authors keying on this action
 *     should branch on that pair to separate self-healing drift records
 *     from human configuration changes.
 */
export interface RecordMcpServerConfigUpdatedParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  changed_fields: string[];
  reason?: string;
  request_source: RequestSource;
}

export async function recordMcpServerConfigUpdated(
  p: RecordMcpServerConfigUpdatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_CONFIG_UPDATED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      reason: p.reason ?? null,
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
        changed_fields: p.changed_fields,
      },
    },
    p.executor,
  );
}

export interface RecordMcpServerDisabledParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  reason?: string;
  request_source: RequestSource;
}

export async function recordMcpServerDisabled(
  p: RecordMcpServerDisabledParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_DISABLED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      reason: p.reason ?? null,
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
      },
    },
    p.executor,
  );
}

export interface RecordMcpServerReEnabledParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  reason?: string;
  request_source: RequestSource;
}

export async function recordMcpServerReEnabled(
  p: RecordMcpServerReEnabledParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_RE_ENABLED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      reason: p.reason ?? null,
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
      },
    },
    p.executor,
  );
}

export interface RecordMcpServerErroredParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  last_error: string;
  request_source: RequestSource;
}

export async function recordMcpServerErrored(
  p: RecordMcpServerErroredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_ERRORED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "error",
      reason: p.last_error,
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
      },
    },
    p.executor,
  );
}

export interface RecordMcpServerDeletedParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  reason?: string;
  request_source: RequestSource;
}

export async function recordMcpServerDeleted(
  p: RecordMcpServerDeletedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_DELETED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      reason: p.reason ?? null,
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
      },
    },
    p.executor,
  );
}

export interface RecordMcpServerHandshakeOkParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  tool_count: number;
  manifest_hash: string;
  request_source: RequestSource;
}

export async function recordMcpServerHandshakeOk(
  p: RecordMcpServerHandshakeOkParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_HANDSHAKE_OK,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
        tool_count: p.tool_count,
        manifest_hash: p.manifest_hash,
      },
    },
    p.executor,
  );
}

export interface RecordMcpExternalToolInvokedParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  remote_tool: string;
  outcome: "success" | "error";
  duration_ms: number;
  /** Raw response byte count; bucketed to a coarse size before storage. */
  byte_count: number;
  request_source: RequestSource;
}

export async function recordMcpExternalToolInvoked(
  p: RecordMcpExternalToolInvokedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_EXTERNAL_TOOL_INVOKED,
      resource_type: "mcp_external_tool",
      resource_id: p.mcp_server_id,
      result: p.outcome === "success" ? "success" : "error",
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
        remote_tool: p.remote_tool,
        outcome: p.outcome,
        duration_ms: p.duration_ms,
        // Low-cardinality bucket — never the raw byte count, mirroring
        // the files subsystem's `size_bytes_bucket` discipline.
        byte_count_bucket: bucketSize(p.byte_count),
      },
    },
    p.executor,
  );
}

export interface RecordMcpExternalToolPaletteAssemblyFailedParams extends RecorderBase {
  /** Why the palette assembly failed (DB error, pool fault). The CALLER
   *  pre-redacts this value (`redactLastError`: embedded URLs reduced to
   *  host-only, length-capped) before passing it in — never hand a raw
   *  transport/DB error message to this recorder. */
  reason: string;
  request_source: RequestSource;
}

/**
 * Audit a turn whose external-MCP tool palette failed to assemble. The
 * turn proceeds with zero external tools (the failure is non-fatal), so
 * this row is the only durable, queryable evidence that a tenant's
 * external tools were silently absent for a turn. `resource_id` is the
 * tenant id (there is no single server to attribute the failure to — the
 * fault is at the tenant-wide enumeration/pool layer).
 */
export async function recordMcpExternalToolPaletteAssemblyFailed(
  p: RecordMcpExternalToolPaletteAssemblyFailedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_EXTERNAL_TOOL_PALETTE_ASSEMBLY_FAILED,
      resource_type: "mcp_external_tool",
      resource_id: p.tenant_id,
      result: "error",
      reason: p.reason,
      metadata: {
        request_source: p.request_source,
      },
    },
    p.executor,
  );
}

// ── interactive browser OAuth 2.1 onboarding (#171 follow-up) ─────────────
//
// Lifecycle of authorizing an OAuth-only external MCP server. SECRET-BY-
// REFERENCE: `issuer` is reduced to its HOST via `urlHost` before storage
// — never the access/refresh token, the authorization URL, or any query
// string. The resulting token is written to the `credentials` table by the
// callback handler, not carried in any audit metadata.

export interface RecordMcpServerAuthorizationStartedParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  /** OAuth issuer / authorization-server URL. Reduced to host before storage. */
  issuer: string;
  request_source: RequestSource;
}

export async function recordMcpServerAuthorizationStarted(
  p: RecordMcpServerAuthorizationStartedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_AUTHORIZATION_STARTED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
        issuer_host: urlHost(p.issuer),
      },
    },
    p.executor,
  );
}

export interface RecordMcpServerAuthorizedParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  /** OAuth issuer / authorization-server URL. Reduced to host before storage. */
  issuer: string;
  request_source: RequestSource;
}

export async function recordMcpServerAuthorized(
  p: RecordMcpServerAuthorizedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_AUTHORIZED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
        issuer_host: urlHost(p.issuer),
      },
    },
    p.executor,
  );
}

export interface RecordMcpServerAuthorizationFailedParams extends RecorderBase {
  mcp_server_id: string;
  namespace: string;
  /** OAuth issuer / authorization-server URL. Reduced to host before storage. */
  issuer: string;
  /** Why the authorization failed (bad state, issuer mismatch, exchange error). */
  reason: string;
  request_source: RequestSource;
}

export async function recordMcpServerAuthorizationFailed(
  p: RecordMcpServerAuthorizationFailedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.MCP_SERVER_AUTHORIZATION_FAILED,
      resource_type: "mcp_server",
      resource_id: p.mcp_server_id,
      result: "error",
      reason: p.reason,
      metadata: {
        request_source: p.request_source,
        namespace: p.namespace,
        issuer_host: urlHost(p.issuer),
      },
    },
    p.executor,
  );
}
