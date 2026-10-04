import type { RequestSource } from "../../observability/service-metadata.ts";
import { auditAwait } from "../audit.ts";
import { bucketSize } from "../buckets.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

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

export interface RecordConnectorMcpClientRegisteredParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
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
  remote_tool: string;
  operation: string;
  outcome: "success" | "error" | "cancelled";
  gate_rule?: "connector_trust";
  advertised_side_effect?: "read" | "write";
  structured?: boolean;
  duration_ms: number;
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
        byte_count_bucket: bucketSize(p.byte_count),
      },
    },
    p.executor,
  );
}

export type PaletteAssemblyFailureReason = "tenant_mismatch" | "db_error" | "pool_fault";

export interface RecordMcpExternalToolPaletteAssemblyFailedParams extends RecorderBase {
  reason: PaletteAssemblyFailureReason;
  detail?: string;
  request_source: RequestSource;
}

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

export interface RecordConnectorMcpAuthorizationParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
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
