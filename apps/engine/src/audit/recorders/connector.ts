import { audit, auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type AuditOutcome, type RecordedEntry, type RecorderBase, resolveActor } from "./types.ts";

export interface RecordConnectorCreatedParams extends RecorderBase {
  connector_id: string;
  slug: string;
  driver: string;
  environment: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call";
  credential_persisted?: boolean;
  commit_intent_kind?: string;
}

export async function recordConnectorCreated(
  p: RecordConnectorCreatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONNECTOR_CREATED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        slug: p.slug,
        driver: p.driver,
        environment: p.environment,
        ...(p.credential_persisted !== undefined
          ? { credential_persisted: p.credential_persisted }
          : {}),
        ...(p.commit_intent_kind ? { commit_intent_kind: p.commit_intent_kind } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorUpdatedParams extends RecorderBase {
  connector_id: string;
  kind: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call";
  environment?: string;
  credential_mode?: string;
  credential_persisted?: boolean;
  idempotent?: boolean;
  commit_intent_kind?: string;
  tool?: string;
}

export async function recordConnectorUpdated(
  p: RecordConnectorUpdatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONNECTOR_UPDATED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        kind: p.kind,
        ...(p.environment ? { environment: p.environment } : {}),
        ...(p.credential_mode ? { credential_mode: p.credential_mode } : {}),
        ...(p.credential_persisted !== undefined
          ? { credential_persisted: p.credential_persisted }
          : {}),
        ...(p.idempotent !== undefined ? { idempotent: p.idempotent } : {}),
        ...(p.tool ? { tool: p.tool } : {}),
        ...(p.commit_intent_kind ? { commit_intent_kind: p.commit_intent_kind } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorDeletedParams extends RecorderBase {
  connector_id: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
  slug?: string;
}

export async function recordConnectorDeleted(
  p: RecordConnectorDeletedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONNECTOR_DELETED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        ...(p.slug ? { slug: p.slug } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorInvokedParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
  driver: string;
  environment: string;
  method: string;
  path: string;
  url_host: string;
  status_code: number;
  latency_ms: number;
  outcome: AuditOutcome;
  conversation_id?: string;
  created_resource_id?: string;
}

export async function recordConnectorInvoked(
  p: RecordConnectorInvokedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONNECTOR_INVOKED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: p.outcome,
      reason: "tool_invocation",
      metadata: {
        ...(p.conversation_id ? { conversation_id: p.conversation_id } : {}),
        connector_id: p.connector_id,
        connector_slug: p.connector_slug,
        driver: p.driver,
        environment: p.environment,
        method: p.method,
        path: p.path,
        url_host: p.url_host,
        status_code: p.status_code,
        latency_ms: p.latency_ms,
        ...(p.created_resource_id ? { created_resource_id: p.created_resource_id } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorProbedParams extends RecorderBase {
  connector: {
    id: string;
    slug: string;
    driver: string;
    environment: string;
    base_url: string | null;
  };
  result: { ok: boolean; status?: number; latency_ms: number; error_code?: string };
  conversation_id?: string;
}

export async function recordConnectorProbed(
  p: RecordConnectorProbedParams,
): Promise<RecordedEntry | null> {
  if (p.result.error_code === "connector_disabled") return null;
  let url_host = "";
  if (p.connector.base_url) {
    try {
      url_host = new URL(p.connector.base_url).host;
    } catch {
      url_host = p.connector.base_url;
    }
  }
  return recordConnectorInvoked({
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    ...(p.actor_type ? { actor_type: p.actor_type } : {}),
    ...(p.executor ? { executor: p.executor } : {}),
    connector_id: p.connector.id,
    connector_slug: p.connector.slug,
    driver: p.connector.driver,
    environment: p.connector.environment,
    method: "PROBE",
    path: "/",
    url_host,
    status_code: p.result.status ?? (p.result.ok ? 200 : 0),
    latency_ms: p.result.latency_ms,
    outcome: p.result.ok ? "success" : "error",
    ...(p.conversation_id ? { conversation_id: p.conversation_id } : {}),
  });
}

export interface RecordConnectorSavedOverrideParams extends RecorderBase {
  connector_id: string;
  slug: string;
  driver: string;
  environment: string;
  reason: string;
  latest_probe: unknown | null;
  source: "harness_auto_persist" | "tool_call";
  tool?: string;
  probe_failure_code?: string | null;
  kind?: string;
  forced?: boolean;
  cooldown_bypassed?: boolean;
}

export async function recordConnectorSavedOverride(
  p: RecordConnectorSavedOverrideParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONNECTOR_SAVED_OVERRIDE,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        kind: p.kind ?? "force_save_override",
        slug: p.slug,
        driver: p.driver,
        environment: p.environment,
        latest_probe: p.latest_probe ?? null,
        ...(p.tool ? { tool: p.tool } : {}),
        ...(p.probe_failure_code !== undefined ? { probe_failure_code: p.probe_failure_code } : {}),
        ...(p.forced !== undefined ? { forced: p.forced } : {}),
        ...(p.cooldown_bypassed !== undefined ? { cooldown_bypassed: p.cooldown_bypassed } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorDiscoveredParams extends RecorderBase {
  connector_id: string;
  strategy: string;
  cache_key: string;
  source: "cache" | "fresh";
  endpoint_count: number;
  warnings: ReadonlyArray<{ code: string; message: string }>;
}

export async function recordConnectorDiscovered(
  p: RecordConnectorDiscoveredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONNECTOR_DISCOVERED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: null,
      metadata: {
        strategy: p.strategy,
        cache_key: p.cache_key,
        source: p.source,
        endpoint_count: p.endpoint_count,
        warning_count: p.warnings.length,
        ...(p.warnings.length > 0 ? { warnings: p.warnings.slice(0, 25) } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorDraftCredentialRejectedParams extends RecorderBase {
  conversation_id: string;
  matched_key_path: string;
  reason?: "credential_must_use_form" | "auth_param_name_in_config";
}

export function recordConnectorDraftCredentialRejected(
  p: RecordConnectorDraftCredentialRejectedParams,
): RecordedEntry {
  return audit(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "denied",
      reason: p.reason ?? "credential_must_use_form",
      metadata: {
        conversation_id: p.conversation_id,
        matched_key_path: p.matched_key_path,
      },
    },
    p.executor,
  );
}
