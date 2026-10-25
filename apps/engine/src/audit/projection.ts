import { z } from "zod";
import { scrubSecrets } from "../logging/scrub-secrets.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { auditResourceName } from "./resource-name.ts";
import { sanitizeForAudit } from "./sanitize.ts";
import type { AuditEntry } from "./types.ts";

const UUID = z.string().uuid();
const DISPLAY_FIELDS: Record<string, readonly string[]> = {
  knowledge_source: ["name", "status"],
  workflow: ["name", "status", "enabled"],
  connector: ["name", "display_name", "status", "enabled"],
  skill: ["name", "title", "status"],
  file: ["filename", "status"],
};
const DETAIL_FIELDS: Record<string, readonly string[]> = {
  "workflow.updated": [
    "operation",
    "kind",
    "tool",
    "version",
    "workflow_version_id",
    "previous_version_id",
    "bypassed_prior_approval",
  ],
  "workflow.authority_granted": [
    "workflow_version_id",
    "execution_environment",
    "valid_from",
    "valid_until",
    "max_runs",
    "open_ended",
  ],
  "workflow.authority_revoked": ["workflow_version_id", "execution_environment"],
  "schedule.admission.changed": ["state", "reason_code"],
  "schedule.created": ["cron", "timezone", "execution_mode", "paused"],
  "schedule.updated": ["cron", "timezone", "execution_mode", "paused"],
  "execution.queued": [
    "purpose",
    "source_kind",
    "workflow_version_id",
    "execution_mode",
    "hold_writes",
  ],
};
const DETAIL_TEXT = /^[A-Za-z0-9 _.:*/+-]{1,64}$/;
const CORRELATION_ID = /^[0-9a-f]{32}$/;
const ACCESS_TYPES = [
  "api_key",
  "browser_session",
  "mcp_oauth",
  "token_exchange",
  "external_bearer",
  "portal_token",
] as const;
const SAFE_REASONS = new Set([
  "expired_sliding",
  "expired_absolute",
  "idle_timeout",
  "logout",
  "revoked",
  "user_deactivated",
  "bad_signature",
  "credential_rejected",
  "circuit_open",
  "operator_rejected_confirmation",
  "execution_authority_required",
  "execution_authority_unavailable",
  "refresh_replayed",
  "manual_re_issue",
  "client_retired",
  "auto_mode_no_prior_approval",
  "manual_re_issue",
  "force_save_override",
  "playbook_updated",
  "playbook_decision_applied",
  "playbook_turn_settled",
]);

function recordedId(value: unknown): string | null {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeDisplayValue(value: unknown): string | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || value.length > 120) return null;
  return sanitizeForAudit(scrubSecrets(value) as string);
}

function detailValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (UUID.safeParse(value).success) return value;
  if (!Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  return DETAIL_TEXT.test(value) ? value : undefined;
}

function recordedDetails(entry: AuditEntry): Record<string, string | number | boolean | null> {
  const fields = DETAIL_FIELDS[entry.action] ?? [];
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (!Object.hasOwn(entry.metadata, field)) return [];
      const value = detailValue(entry.metadata[field]);
      return value === undefined ? [] : [[field, value]];
    }),
  );
}

function provenChanges(entry: AuditEntry): Array<{
  field: string;
  before: string | boolean;
  after: string | boolean;
}> {
  const before = entry.before;
  const after = entry.after;
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  if (Array.isArray(before) || Array.isArray(after)) return [];
  return (DISPLAY_FIELDS[entry.resource_type] ?? []).flatMap((field) => {
    if (!Object.hasOwn(before, field) || !Object.hasOwn(after, field)) return [];
    const previous = safeDisplayValue((before as Record<string, unknown>)[field]);
    const next = safeDisplayValue((after as Record<string, unknown>)[field]);
    if (previous === null || next === null || previous === next) return [];
    return [{ field, before: previous, after: next }];
  });
}

export function projectAuditEntry(entry: AuditEntry): Record<string, unknown> {
  const source = RequestSourceSchema.safeParse(entry.metadata.request_source);
  const origin = RequestSourceSchema.safeParse(entry.metadata.origin_source);
  const execution = RequestSourceSchema.safeParse(entry.metadata.execution_source);
  const apiKeyId = recordedId(entry.metadata.audit_used_api_key_id);
  const sessionId = recordedId(entry.metadata.audit_used_session_id);
  const accessType = ACCESS_TYPES.find((type) => type === entry.metadata.audit_access_type) ?? null;
  const recordedApiKeyId = accessType ? null : recordedId(entry.metadata.api_key_id);
  const recordedSessionId = accessType ? null : recordedId(entry.metadata.session_id);
  const oauthClientId =
    typeof entry.metadata.audit_oauth_client_id === "string" &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(entry.metadata.audit_oauth_client_id)
      ? entry.metadata.audit_oauth_client_id
      : null;
  const credentialOrigin =
    entry.metadata.audit_credential_origin === "cli_oauth_session" ? "cli_oauth_session" : null;
  const reason = entry.reason && SAFE_REASONS.has(entry.reason) ? entry.reason : null;
  const executionId =
    entry.resource_type === "execution"
      ? recordedId(entry.resource_id)
      : recordedId(entry.metadata.execution_id);
  const conversationId =
    entry.resource_type === "conversation"
      ? recordedId(entry.resource_id)
      : recordedId(entry.metadata.conversation_id);
  const workflowId =
    entry.resource_type === "workflow"
      ? recordedId(entry.resource_id)
      : recordedId(entry.metadata.workflow_id);
  const requestSource = source.success ? source.data : null;
  const correlationId =
    typeof entry.metadata.audit_trace_id === "string" &&
    CORRELATION_ID.test(entry.metadata.audit_trace_id)
      ? entry.metadata.audit_trace_id
      : null;
  const originSource = origin.success ? origin.data : null;
  const executionSource = execution.success ? execution.data : null;
  const recordedName = ["user", "system_account", "mcp_oauth_client", "group", "role"].includes(
    entry.resource_type,
  )
    ? null
    : auditResourceName(entry);
  const resourceName = recordedName ? sanitizeForAudit(scrubSecrets(recordedName) as string) : null;
  const changes = provenChanges(entry);
  return {
    id: entry.id,
    ts: entry.ts.toISOString(),
    tenant_id: entry.tenant_id,
    actor_type: entry.actor_type,
    actor_id: entry.actor_id,
    action: entry.action,
    resource_type: entry.resource_type,
    resource_id: entry.resource_id,
    resource_name: resourceName,
    result: entry.result,
    trace_id: entry.trace_id,
    correlation_id: correlationId,
    request_source: requestSource,
    origin_source: originSource,
    execution_source: executionSource,
    api_key_id: apiKeyId,
    session_id: sessionId,
    recorded_api_key_id: recordedApiKeyId,
    recorded_session_id: recordedSessionId,
    access_type: accessType,
    oauth_client_id: oauthClientId,
    credential_origin: credentialOrigin,
    execution_id: executionId,
    conversation_id: conversationId,
    workflow_id: workflowId,
    ip: null,
    user_agent: null,
    before: null,
    after: null,
    reason,
    reason_redacted: Boolean(entry.reason && !reason),
    changed_fields: changes.map((change) => change.field),
    changes,
    details: recordedDetails(entry),
    metadata: {
      ...(requestSource ? { request_source: requestSource } : {}),
      ...(originSource ? { origin_source: originSource } : {}),
      ...(executionSource ? { execution_source: executionSource } : {}),
      ...(apiKeyId ? { api_key_id: apiKeyId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(accessType ? { access_type: accessType } : {}),
      ...(oauthClientId ? { oauth_client_id: oauthClientId } : {}),
      ...(credentialOrigin ? { credential_origin: credentialOrigin } : {}),
      ...(executionId ? { execution_id: executionId } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(workflowId ? { workflow_id: workflowId } : {}),
    },
  };
}
