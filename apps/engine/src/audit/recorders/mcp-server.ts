// External MCP session audit recorders.
//
// An external MCP server is a connector whose driver is `mcp`, so its
// CONFIGURATION lifecycle (created / updated / deleted / health_changed)
// is recorded by the connector recorders. What lives here is the handful
// of events only a negotiated MCP session produces — a handshake, a
// manifest the remote reshaped, a dynamically-registered OAuth client,
// the interactive authorization round-trip — plus the two invocation rows.
//
// SECRET-BY-REFERENCE: these recorders MUST NOT carry a full URL with a
// query string, a token, or any auth material. Only the URL *host* is
// recorded (extracted via `urlHost` below, mirroring the
// `issuer_url_host` pattern in credential.ts). The `tools_manifest_hash`
// and `tool_count` are non-secret integrity/sizing signals.
//
// Every row carries `request_source` (CLI vs API vs MCP) in metadata so
// operators can attribute a change to the surface that drove it, and
// `tenant_id` so the trail stays tenant-scoped.

import type { RequestSource } from "../../observability/service-metadata.ts";
import { auditAwait } from "../audit.ts";
import { bucketSize } from "../buckets.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

/**
 * Reduce an arbitrary URL to just its host so the audit trail never
 * carries a query string, path, token, or secret. Mirrors the
 * `issuer_url_host` extraction in credential.ts. A value that does not
 * parse as a URL is passed through unchanged — there is no host to leak
 * in that case.
 */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface RecordConnectorMcpHandshakeOkParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
  tool_count: number;
  manifest_hash: string;
  request_source: RequestSource;
}

export async function recordConnectorMcpHandshakeOk(
  p: RecordConnectorMcpHandshakeOkParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_MCP_HANDSHAKE_OK,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        connector_slug: p.connector_slug,
        tool_count: p.tool_count,
        manifest_hash: p.manifest_hash,
      },
    },
    p.executor,
  );
}

/**
 * The remote reshaped its tool manifest between two handshakes.
 *
 * A DEDICATED action rather than a generic update row with a
 * `changed_fields` convention: `tools_manifest_hash` lives on
 * `connector_mcp_sessions`, which no operator surface can write, so the
 * existence of this row already means "the remote changed" — structurally,
 * not by agreement between a writer and whoever reads the trail.
 */
export interface RecordConnectorMcpManifestDriftParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
  previous_hash: string;
  observed_hash: string;
  observed_tool_count: number;
  request_source: RequestSource;
}

export async function recordConnectorMcpManifestDrift(
  p: RecordConnectorMcpManifestDriftParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_MCP_MANIFEST_DRIFT,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: "tool_manifest_drift",
      metadata: {
        request_source: p.request_source,
        connector_slug: p.connector_slug,
        previous_hash: p.previous_hash,
        observed_hash: p.observed_hash,
        observed_tool_count: p.observed_tool_count,
      },
    },
    p.executor,
  );
}

/** An RFC 7591 dynamic client registration landed (or was cleared). The
 *  `client_secret` never appears in metadata — only the non-secret id. */
export interface RecordConnectorMcpClientRegisteredParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
  /** Null when the registration was CLEARED so the next flow re-registers. */
  client_id: string | null;
  request_source: RequestSource;
}

export async function recordConnectorMcpClientRegistered(
  p: RecordConnectorMcpClientRegisteredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_MCP_CLIENT_REGISTERED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        connector_slug: p.connector_slug,
        client_id: p.client_id,
      },
    },
    p.executor,
  );
}

export interface RecordMcpExternalToolInvokedParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
  /** What was called: the tool name, the prompt name, or the resource URI
   *  with its query string dropped. */
  remote_tool: string;
  /** The MCP method issued (`tools/call`, `resources/read`, `prompts/get`).
   *  Without it `remote_tool` is ambiguous — a tool and a prompt can share
   *  a name, and an operator reconciling a trail cannot tell a read from a
   *  call. */
  operation: string;
  /** `cancelled` is its own outcome: the caller stopped the call, so it is
   *  neither the remote succeeding nor the remote failing, and collapsing
   *  it into `error` would have an operator hunting a fault that was a
   *  user pressing stop. */
  outcome: "success" | "error" | "cancelled";
  /** Set when the call ran WITHOUT the confirm pause because an operator
   *  marked this remote tool "Ohne Rückfrage" on the connector. The trail
   *  names the rule that let it through; absent on every confirmed call. */
  gate_rule?: "connector_trust";
  /** What the remote's OWN annotations claimed about this tool, when it
   *  claimed anything. Present so a trail records the claim next to the
   *  treatment: the engine gates every `tools/call` as a write, and this
   *  is how an operator sees a server asserting otherwise. Absent for the
   *  operations that address no tool. */
  advertised_side_effect?: "read" | "write";
  /** Whether the reply carried `structuredContent` — the typed half the
   *  SDK validated against the tool's declared output schema. */
  structured?: boolean;
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
      resource_id: p.connector_id,
      // A call the caller stopped is `denied`, not `error`: the remote did not
      // fail, a person withheld the call. Counting it as an error put the
      // user's stop into the connector's failure rate and sent the operator
      // looking for a fault in the remote.
      result: p.outcome === "success" ? "success" : p.outcome === "cancelled" ? "denied" : "error",
      metadata: {
        request_source: p.request_source,
        connector_slug: p.connector_slug,
        remote_tool: p.remote_tool,
        operation: p.operation,
        outcome: p.outcome,
        ...(p.advertised_side_effect !== undefined
          ? { advertised_side_effect: p.advertised_side_effect }
          : {}),
        ...(p.structured !== undefined ? { structured: p.structured } : {}),
        ...(p.gate_rule !== undefined ? { gate_rule: p.gate_rule } : {}),
        duration_ms: p.duration_ms,
        // Low-cardinality bucket — never the raw byte count, mirroring
        // the files subsystem's `size_bytes_bucket` discipline.
        byte_count_bucket: bucketSize(p.byte_count),
      },
    },
    p.executor,
  );
}

/**
 * Why an external-MCP tool palette failed to assemble. Low-cardinality and
 * queryable, so SIEM rules can branch on the failure class:
 *   - `tenant_mismatch` — the dispatch-boundary tenant invariant broke
 *     (ctx.tenant_id !== principal.tenant_id).
 *   - `db_error` — the connectable-connector enumeration failed at the DB.
 *   - `pool_fault` — the client pool faulted while assembling manifests
 *     (also the catch-all where DB vs. pool cannot be told apart).
 */
export type PaletteAssemblyFailureReason = "tenant_mismatch" | "db_error" | "pool_fault";

export interface RecordMcpExternalToolPaletteAssemblyFailedParams extends RecorderBase {
  /** Typed failure class — lands in the audit `reason` column. */
  reason: PaletteAssemblyFailureReason;
  /** Optional human-readable detail, kept in metadata. The CALLER
   *  pre-redacts this value (`redactUpstreamDetail`: embedded URLs reduced to
   *  host-only, length-capped) before passing it in — never hand a raw
   *  transport/DB error message to this recorder. */
  detail?: string;
  request_source: RequestSource;
}

/**
 * Audit a turn whose external-MCP tool palette failed to assemble. The
 * turn proceeds with zero external tools (the failure is non-fatal), so
 * this row is the only durable, queryable evidence that a tenant's
 * external tools were silently absent for a turn. `resource_id` is the
 * tenant id (there is no single connector to attribute the failure to —
 * the fault is at the tenant-wide enumeration/pool layer).
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
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      },
    },
    p.executor,
  );
}

// ── interactive browser OAuth 2.1 onboarding ─────────────
//
// Lifecycle of authorizing an OAuth-only external MCP server. SECRET-BY-
// REFERENCE: `issuer` is reduced to its HOST via `urlHost` before storage
// — never the access/refresh token, the authorization URL, or any query
// string. The resulting token is written to the `credentials` table by the
// callback handler, not carried in any audit metadata.

export interface RecordConnectorMcpAuthorizationParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
  /** OAuth issuer / authorization-server URL. Reduced to host before storage. */
  issuer: string;
  request_source: RequestSource;
}

export async function recordConnectorMcpAuthorizationStarted(
  p: RecordConnectorMcpAuthorizationParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_MCP_AUTHORIZATION_STARTED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        connector_slug: p.connector_slug,
        issuer_host: urlHost(p.issuer),
      },
    },
    p.executor,
  );
}

export async function recordConnectorMcpAuthorized(
  p: RecordConnectorMcpAuthorizationParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_MCP_AUTHORIZED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      metadata: {
        request_source: p.request_source,
        connector_slug: p.connector_slug,
        issuer_host: urlHost(p.issuer),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorMcpAuthorizationFailedParams
  extends RecordConnectorMcpAuthorizationParams {
  /** Why the authorization failed (bad state, issuer mismatch, exchange error). */
  reason: string;
}

export async function recordConnectorMcpAuthorizationFailed(
  p: RecordConnectorMcpAuthorizationFailedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_MCP_AUTHORIZATION_FAILED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "error",
      reason: p.reason,
      metadata: {
        request_source: p.request_source,
        connector_slug: p.connector_slug,
        issuer_host: urlHost(p.issuer),
      },
    },
    p.executor,
  );
}
