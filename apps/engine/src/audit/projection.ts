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
const CORRELATION_ID = /^[0-9a-f]{32}$/;

function recordedId(value: unknown): string | null {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeDisplayValue(value: unknown): string | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || value.length > 120) return null;
  return sanitizeForAudit(scrubSecrets(value) as string);
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
  const apiKeyId = recordedId(entry.metadata.api_key_id);
  const sessionId = recordedId(entry.metadata.session_id);
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
    execution_id: executionId,
    conversation_id: conversationId,
    workflow_id: workflowId,
    ip: null,
    user_agent: null,
    before: null,
    after: null,
    reason: null,
    changed_fields: changes.map((change) => change.field),
    changes,
    metadata: {
      ...(requestSource ? { request_source: requestSource } : {}),
      ...(originSource ? { origin_source: originSource } : {}),
      ...(executionSource ? { execution_source: executionSource } : {}),
      ...(apiKeyId ? { api_key_id: apiKeyId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(executionId ? { execution_id: executionId } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(workflowId ? { workflow_id: workflowId } : {}),
    },
  };
}
