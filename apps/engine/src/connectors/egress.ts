import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import type { AuditActorType, AuditEntry } from "../audit/types.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { getContext } from "../logging/context.ts";

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "password",
  "signature",
  "sig",
  "session",
  "sid",
  "auth",
  "code",
  "x-amz-signature",
  "x-amz-credential",
]);

export function isSensitiveQueryKey(key: string): boolean {
  return SENSITIVE_QUERY_KEYS.has(key.toLowerCase());
}

export function urlHasInlineCredentials(url: URL | string): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  return Boolean(
    parsed.username || parsed.password || [...parsed.searchParams.keys()].some(isSensitiveQueryKey),
  );
}

export function scrubUrl(url: URL | string): string {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : new URL(url.toString());
  } catch {
    return typeof url === "string" ? url : url.toString();
  }
  let mutated = false;
  if (parsed.username || parsed.password) {
    parsed.username = "***";
    parsed.password = "***";
    mutated = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveQueryKey(key)) {
      parsed.searchParams.set(key, "***");
      mutated = true;
    }
  }
  return mutated ? parsed.toString() : parsed.toString();
}

export function injectTraceContext(headers: Record<string, string>): void {
  if (headers.traceparent || headers.Traceparent) return;
  const ctx = getContext();
  const traceId = ctx.trace_id;
  if (!traceId) return;
  const trace = traceId
    .replace(/[^0-9a-f]/gi, "")
    .toLowerCase()
    .padStart(32, "0")
    .slice(0, 32);
  const span = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  headers.traceparent = `00-${trace}-${span}-01`;
}

export type EgressKind = "http" | "graphql" | "s3" | "postgres" | "mcp";

export interface EgressInput {
  executor?: Db;
  tenant_id: string;
  actor_id: string | null;
  actor_type?: AuditActorType;
  connector_id: string;
  connector_slug: string;
  driver: EgressKind;
  credential_id: string | null;
  operation?: string;
  url?: URL | string | null;
  source?: "execution" | "test" | "tool" | "scheduler";
  execution_id?: string | null;
  workflow_id?: string | null;
  step_id?: string | null;
}

interface EgressOutcome {
  status?: number | null;
  bytes_in?: number | null;
  ok?: boolean;
  reason?: string;
  created_resource_id?: string;
}

const CREATED_RESOURCE_ID_KEYS = ["id", "messageId", "message_id", "name", "key", "uuid"] as const;
export function extractCreatedResourceId(method: string, body: unknown): string | undefined {
  const m = method.toUpperCase();
  if (m !== "POST" && m !== "PUT" && m !== "PATCH") return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const obj = body as Record<string, unknown>;
  for (const key of CREATED_RESOURCE_ID_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 256) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

type EgressAuditWriter = (entry: Partial<AuditEntry>) => Promise<unknown>;

export async function withEgressAudit<T>(
  input: EgressInput,
  fn: () => Promise<T>,
  extract?: (result: T) => EgressOutcome | undefined,
  auditWriter: EgressAuditWriter = (entry) => auditAwait(entry, input.executor),
): Promise<T> {
  const start = Date.now();
  const url = input.url ?? null;
  const url_host = url ? safeHost(url) : null;
  const path = url ? safePath(url) : null;
  const url_redacted = url ? scrubUrl(url) : null;

  const emitCredentialAccess = async (credential_id: string) => {
    await auditWriter({
      tenant_id: input.tenant_id,
      ...resolveActor(input),
      action: AuditAction.CREDENTIAL_ACCESSED,
      resource_type: "credential",
      resource_id: credential_id,
      result: "success",
      metadata: {
        connector_id: input.connector_id,
        connector_slug: input.connector_slug,
        driver: input.driver,
        source: input.source ?? "execution",
        ...(input.execution_id ? { execution_id: input.execution_id } : {}),
      },
    });
  };

  if (input.credential_id) await emitCredentialAccess(input.credential_id);

  try {
    const result = await fn();
    const outcome = extract?.(result) ?? {};
    const lateCredentialId = readCredentialId(result);
    if (!input.credential_id && lateCredentialId) await emitCredentialAccess(lateCredentialId);

    const logicalFailure = outcome.ok === false;
    const latencyMs = Date.now() - start;
    await auditWriter({
      tenant_id: input.tenant_id,
      ...resolveActor(input),
      action: AuditAction.CONNECTOR_INVOKED,
      resource_type: "connector",
      resource_id: input.connector_id,
      result: logicalFailure ? "error" : "success",
      ...(logicalFailure ? { reason: outcome.reason ?? "connector returned a logical error" } : {}),
      metadata: {
        connector_id: input.connector_id,
        connector_slug: input.connector_slug,
        driver: input.driver,
        source: input.source ?? "execution",
        ...(input.operation ? { method: input.operation, operation: input.operation } : {}),
        ...(path ? { path } : {}),
        ...(url_host ? { url_host } : {}),
        ...(url_redacted ? { url: url_redacted } : {}),
        ...(outcome.status !== undefined && outcome.status !== null
          ? { status_code: outcome.status, status: outcome.status }
          : {}),
        ...(outcome.bytes_in !== undefined && outcome.bytes_in !== null
          ? { bytes_in: outcome.bytes_in }
          : {}),
        ...(outcome.created_resource_id
          ? { created_resource_id: outcome.created_resource_id }
          : {}),
        latency_ms: latencyMs,
        duration_ms: latencyMs,
        ...(input.credential_id || lateCredentialId
          ? { credential_id: input.credential_id ?? lateCredentialId }
          : {}),
        ...(input.execution_id ? { execution_id: input.execution_id } : {}),
        ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
        ...(input.step_id ? { step_id: input.step_id } : {}),
      },
    });
    return result;
  } catch (err) {
    const latencyMs = Date.now() - start;
    await auditWriter({
      tenant_id: input.tenant_id,
      ...resolveActor(input),
      action: AuditAction.CONNECTOR_INVOKED,
      resource_type: "connector",
      resource_id: input.connector_id,
      result: "error",
      reason: err instanceof Error ? err.message : String(err),
      metadata: {
        connector_id: input.connector_id,
        connector_slug: input.connector_slug,
        driver: input.driver,
        source: input.source ?? "execution",
        ...(input.operation ? { method: input.operation, operation: input.operation } : {}),
        ...(path ? { path } : {}),
        ...(url_host ? { url_host } : {}),
        ...(url_redacted ? { url: url_redacted } : {}),
        latency_ms: latencyMs,
        duration_ms: latencyMs,
        ...(input.credential_id ? { credential_id: input.credential_id } : {}),
        ...(input.execution_id ? { execution_id: input.execution_id } : {}),
        ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
        ...(input.step_id ? { step_id: input.step_id } : {}),
      },
    });
    throw err;
  }
}

function readCredentialId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cid = (value as { credential_id?: unknown }).credential_id;
  return typeof cid === "string" && cid.length > 0 ? cid : null;
}

function safeHost(url: URL | string): string | null {
  try {
    return (typeof url === "string" ? new URL(url) : url).host;
  } catch {
    return null;
  }
}

function safePath(url: URL | string): string | null {
  try {
    return (typeof url === "string" ? new URL(url) : url).pathname;
  } catch {
    return null;
  }
}
