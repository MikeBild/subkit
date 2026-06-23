// Egress audit + trace propagation + URL scrubbing for connector calls.
//
// Single source of truth for the three concerns the docs claim hold for
// every outbound call:
//   - SOC 2 CC9 / docs/07:85: "All egress is logged in the audit log with
//     request source, caller identity, and outcome." → CONNECTOR_INVOKED.
//   - GDPR Art. 32 / SOC 2 CC6.7 / audit/types.ts:187: credential reads
//     during use are forensically tracked. → CREDENTIAL_ACCESSED.
//   - Distributed tracing / W3C Trace Context: outbound HTTP carries a
//     `traceparent` header so external systems can correlate.
//
// URL scrubbing for log lines is also colocated here because the same
// hot paths that touch the URL also need to log it without leaking
// `?token=…` query params.
//
// This module is the wrapper layer; it does not own the driver protocol.

import { auditAwait } from "../audit/audit.ts";
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
  "x-amz-signature",
  "x-amz-credential",
]);

/**
 * Return a string form of `url` with sensitive query params replaced by
 * `***`. Keeps host + path intact so logs stay useful for triage. Accepts
 * either a `URL` instance or a string; on parse failure returns the
 * input unchanged so we never throw from a logging call site.
 */
export function scrubUrl(url: URL | string): string {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : new URL(url.toString());
  } catch {
    return typeof url === "string" ? url : url.toString();
  }
  let mutated = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, "***");
      mutated = true;
    }
  }
  return mutated ? parsed.toString() : parsed.toString();
}

/**
 * Inject W3C Trace Context (`traceparent`) into an outbound header bag
 * if the current async context has a trace_id and one is not already
 * set. Format: `00-<32hex>-<16hex>-01` per
 * https://www.w3.org/TR/trace-context/#traceparent-header.
 *
 * The engine's trace_id is 12 hex chars (collision-resistant within a
 * burst, not globally unique). We pad to 32 hex by left-zero-filling so
 * the header is well-formed; downstream tracing backends will treat the
 * shortened ids as a single trace within a request lifetime, which is
 * the level of correlation we can offer today.
 */
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

export type EgressKind =
  | "http"
  | "graphql"
  | "s3"
  | "postgres"
  | "mssql"
  | "redis"
  | "ftp"
  | "sftp"
  | "smb";

export interface EgressInput {
  executor?: Db;
  tenant_id: string;
  actor_id: string | null;
  actor_type?: AuditActorType;
  connector_id: string;
  connector_slug: string;
  driver: EgressKind;
  /** When the egress used a stored credential, the credential row id.
   *  `null` for `auth_type=none` connectors. */
  credential_id: string | null;
  /** HTTP method, S3 verb, or GraphQL operation. */
  operation?: string;
  /** Target URL or endpoint. Sensitive query params are scrubbed before
   *  logging; the unscrubbed value never leaves this module. */
  url?: URL | string | null;
  /** Identifies what triggered the call so the audit row can answer
   *  "which surface invoked this connector?". */
  source?: "execution" | "test" | "tool" | "scheduler";
  /** Foreign-key handles so the audit row joins back to the run. */
  execution_id?: string | null;
  workflow_id?: string | null;
  step_id?: string | null;
}

export interface EgressOutcome {
  status?: number | null;
  bytes_in?: number | null;
  /**
   * Logical outcome of the call, independent of transport success.
   * A GraphQL response can carry `body.errors` on HTTP 200 — the call
   * reached the wire but the operation failed. When `extract` reports
   * `ok: false` the `CONNECTOR_INVOKED` audit row records
   * `result: "error"` so the audit trail's outcome stays honest
   * (SOC 2 CC9). Omitted / `true` means a normal success.
   */
  ok?: boolean;
  /** Short reason surfaced on the audit row when `ok` is false. */
  reason?: string;
  /**
   * id of the resource a write call created/sent, lifted from the
   * response body (e.g. a Gmail message id from `POST .../messages/send`).
   * Makes "WHAT did this outbound call produce?" answerable from the audit
   * row. Populated by the driver's `extract` callback via
   * `extractCreatedResourceId`; scrubbed like every other metadata field.
   */
  created_resource_id?: string;
}

/**
 * generic created/sent-resource id for the `CONNECTOR_INVOKED` audit
 * row. Only meaningful for writes (non-idempotent methods create or send),
 * so reads/deletes return nothing. Pulls the FIRST id-like top-level field
 * of the response body — the cross-vendor convention for a create/send
 * response (`id`, `messageId`, `name`, …). Deliberately generic: no vendor
 * string is hardcoded, so it covers Gmail message ids, Stripe object ids,
 * Linear issue ids, etc. without special-casing any one.
 */
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

/**
 * Wrap a driver invocation with audit + accounting. Emits exactly one
 * `CONNECTOR_INVOKED` row per call (success or failure) and one
 * `CREDENTIAL_ACCESSED` row when a credential was used.
 *
 * `extract` is an optional projection from the driver's raw result to
 * the egress outcome shape (status code, bytes read). The driver result
 * is returned verbatim; the wrapper does not transform it.
 *
 * The wrapper does not retry, does not log secrets (URL is scrubbed
 * before being placed on the audit metadata), and never swallows the
 * underlying error — it re-throws after recording the failure.
 */
export async function withEgressAudit<T>(
  input: EgressInput,
  fn: () => Promise<T>,
  extract?: (result: T) => EgressOutcome | undefined,
  auditWriter: EgressAuditWriter = (entry) => auditAwait(entry, input.executor),
): Promise<T> {
  const start = Date.now();
  const url = input.url ?? null;
  const url_host = url ? safeHost(url) : null;
  const url_redacted = url ? scrubUrl(url) : null;

  const emitCredentialAccess = async (credential_id: string) => {
    await auditWriter({
      tenant_id: input.tenant_id,
      actor_type: input.actor_type ?? (input.actor_id ? "user" : "system"),
      actor_id: input.actor_id,
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
    // Drivers that did not know their credential id at call time can
    // surface it on the result envelope (`{credential_id}`). Honour it
    // post-call so the audit trail still names the secret that was used.
    const lateCredentialId = readCredentialId(result);
    if (!input.credential_id && lateCredentialId) await emitCredentialAccess(lateCredentialId);

    // A driver can reach the wire and still fail logically — a GraphQL
    // response with `body.errors` on HTTP 200 is the canonical case.
    // `extract` reports that via `ok: false`; the audit outcome must
    // reflect it, not the bare "fn() did not throw".
    const logicalFailure = outcome.ok === false;
    await auditWriter({
      tenant_id: input.tenant_id,
      actor_type: input.actor_type ?? (input.actor_id ? "user" : "system"),
      actor_id: input.actor_id,
      action: AuditAction.CONNECTOR_INVOKED,
      resource_type: "connector",
      resource_id: input.connector_id,
      result: logicalFailure ? "error" : "success",
      ...(logicalFailure ? { reason: outcome.reason ?? "connector returned a logical error" } : {}),
      metadata: {
        connector_slug: input.connector_slug,
        driver: input.driver,
        source: input.source ?? "execution",
        ...(input.operation ? { operation: input.operation } : {}),
        ...(url_host ? { url_host } : {}),
        ...(url_redacted ? { url: url_redacted } : {}),
        ...(outcome.status !== undefined && outcome.status !== null
          ? { status: outcome.status }
          : {}),
        ...(outcome.bytes_in !== undefined && outcome.bytes_in !== null
          ? { bytes_in: outcome.bytes_in }
          : {}),
        ...(outcome.created_resource_id
          ? { created_resource_id: outcome.created_resource_id }
          : {}),
        duration_ms: Date.now() - start,
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
    await auditWriter({
      tenant_id: input.tenant_id,
      actor_type: input.actor_type ?? (input.actor_id ? "user" : "system"),
      actor_id: input.actor_id,
      action: AuditAction.CONNECTOR_INVOKED,
      resource_type: "connector",
      resource_id: input.connector_id,
      result: "error",
      reason: err instanceof Error ? err.message : String(err),
      metadata: {
        connector_slug: input.connector_slug,
        driver: input.driver,
        source: input.source ?? "execution",
        ...(input.operation ? { operation: input.operation } : {}),
        ...(url_host ? { url_host } : {}),
        ...(url_redacted ? { url: url_redacted } : {}),
        duration_ms: Date.now() - start,
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
