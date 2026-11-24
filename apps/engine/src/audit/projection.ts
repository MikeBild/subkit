import { DEVICE_REFUSALS } from "@shared/device/protocol.ts";
import { z } from "zod";
import { LOCAL_SOURCE_REFUSALS } from "../devices/core/run-source.ts";
import { scrubSecrets } from "../logging/scrub-secrets.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { DEVICE_LOSS_CODES } from "./device-metadata.ts";
import { deviceDetails } from "./device-projection.ts";
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
  task: ["name", "lifecycle"],
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
  "tool_policy.confirmation_skipped": [
    "tool",
    "environment",
    "resolver_reason",
    "covering_authority_id",
    "rule_id",
    "message_id",
    "verb",
    "effect_class",
    "job_id",
  ],
  "tool_approval_rule.created": ["tool", "verb", "recipient_count", "approvals_count"],
  "tool_approval_rule.dismissed": ["tool", "verb", "recipient_count", "approvals_count"],
  "tool_approval_rule.revoked": ["tool", "verb", "recipient_count", "approvals_count"],
  "tool_approval_rule.renewed": [
    "tool",
    "verb",
    "recipient_count",
    "approvals_count",
    "content_class",
    "daily_limit",
    "expires_at",
  ],
  "schedule.created": ["cron", "timezone", "execution_mode", "paused"],
  "schedule.updated": ["cron", "timezone", "execution_mode", "paused"],
  "execution.queued": [
    "purpose",
    "source_kind",
    "workflow_version_id",
    "execution_mode",
    "hold_writes",
  ],
  "workspace.approval_policy_changed": ["source", "eligible_approvers"],
};
const APPROVAL_POLICY_SOURCES = new Set(["policy", "setup", "approver_joined"]);
const approvalPolicySource = (entry: AuditEntry): string | null =>
  entry.action === "workspace.approval_policy_changed" &&
  typeof entry.metadata.source === "string" &&
  APPROVAL_POLICY_SOURCES.has(entry.metadata.source)
    ? entry.metadata.source
    : null;
const ID_DETAIL_FIELDS = new Set(["job_id"]);
const DETAIL_TEXT = /^[A-Za-z0-9 _.:*/+-]{1,64}$/;
const CORRELATION_ID = /^[0-9a-f]{32}$/;
export const AUDIT_ACCESS_TYPES = [
  "api_key",
  "browser_session",
  "mcp_oauth",
  "token_exchange",
  "external_bearer",
  "task_run",
  "portal_token",
  "device_runner",
] as const;
export type AuditAccessType = (typeof AUDIT_ACCESS_TYPES)[number];
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
  "authority_covered",
  "user_instruction",
  "standing_rule",
  "manual_re_issue",
  "force_save_override",
  "playbook_updated",
  "playbook_decision_applied",
  "playbook_turn_settled",
  "grant_required",
  "grant_expired",
  "grant_exhausted",
  "grant_fingerprint_mismatch",
  "owner_unavailable",
  "ai_access_missing",
  "previous_run_active",
  "paused",
  "owner_request",
  "admin",
  "question",
  "approval",
  "no_progress",
  "budget",
  "question_expired",
  "ai_access",
  "turn_stopped",
  ...DEVICE_REFUSALS,
  ...DEVICE_LOSS_CODES,
  ...LOCAL_SOURCE_REFUSALS,
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

type Detail = string | number | boolean | null;
type DetailCheck = (value: unknown) => Detail | undefined;

const TASK_CODE = /^[a-z0-9_.:-]{1,200}$/;
const TASK_FINGERPRINT = /^[0-9a-f]{64}$/;
const TASK_ID_LIST_LIMIT = 200;
const TASK_GRANT_ID_LISTS = [
  "workflow_authority_ids",
  "covered_workflow_ids",
  "superseded_grant_ids",
  "revoked_workflow_authority_ids",
  "retained_successor_authority_ids",
  "transferred_workflow_authority_ids",
] as const;

export const TASK_DETAIL_VOCABULARY = {
  environments: ["dev", "prod"],
  triggers: ["manual", "once", "cron"],
  run_states: ["running", "waiting", "sleeping", "result_ready", "completed", "aborted", "failed"],
  waiting_reasons: [
    "question",
    "approval",
    "no_progress",
    "budget",
    "question_expired",
    "ai_access",
    "turn_stopped",
  ],
  admission_reasons: [
    "grant_required",
    "grant_expired",
    "grant_exhausted",
    "grant_fingerprint_mismatch",
    "owner_unavailable",
    "ai_access_missing",
    "previous_run_active",
    "paused",
  ],
  paused_reasons: ["owner_request", "admin", "owner_unavailable"],
  schedule_kinds: ["none", "cron", "once"],
  admission_states: ["held", "admitted"],
} as const;

function oneOf(allowed: readonly string[]): DetailCheck {
  return (value) => (typeof value === "string" && allowed.includes(value) ? value : undefined);
}

function matching(pattern: RegExp): DetailCheck {
  return (value) => (typeof value === "string" && pattern.test(value) ? value : undefined);
}

function nullable(check: DetailCheck): DetailCheck {
  return (value) => (value === null ? null : check(value));
}

const detailId: DetailCheck = (value) => recordedId(value) ?? undefined;
const taskCount: DetailCheck = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
const taskFlag: DetailCheck = (value) => (typeof value === "boolean" ? value : undefined);
const taskInstant: DetailCheck = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;

function buildTaskDetailChecks(): Record<string, Record<string, DetailCheck>> {
  const environment = oneOf(TASK_DETAIL_VOCABULARY.environments);
  const trigger = oneOf(TASK_DETAIL_VOCABULARY.triggers);
  const runState = oneOf(TASK_DETAIL_VOCABULARY.run_states);
  const scheduleKind = oneOf(TASK_DETAIL_VOCABULARY.schedule_kinds);
  const code = matching(TASK_CODE);
  const grant = {
    task_grant_id: detailId,
    execution_environment: environment,
    fingerprint: matching(TASK_FINGERPRINT),
    valid_from: taskInstant,
    valid_until: nullable(taskInstant),
    max_runs: nullable(taskCount),
    open_ended: taskFlag,
  };
  return {
    "task.created": {
      revision: taskCount,
      environment,
      owner_id: detailId,
      schedule_kind: scheduleKind,
    },
    "task.updated": {
      revision: taskCount,
      previous_revision: taskCount,
      environment,
      schedule_kind: scheduleKind,
      grant_invalidated: taskFlag,
    },
    "task.deleted": { revision: taskCount },
    "task.paused": { paused_reason: oneOf(TASK_DETAIL_VOCABULARY.paused_reasons) },
    "task.resumed": { previous_paused_reason: oneOf(TASK_DETAIL_VOCABULARY.paused_reasons) },
    "task.authority_granted": grant,
    "task.authority_revoked": { ...grant, reason_code: code, reserved_runs: taskCount },
    "task.admission.changed": {
      state: oneOf(TASK_DETAIL_VOCABULARY.admission_states),
      reason_code: nullable(oneOf(TASK_DETAIL_VOCABULARY.admission_reasons)),
      trigger,
    },
    "task.schedule_claimed": {
      trigger,
      scheduled_for: taskInstant,
      task_grant_id: nullable(detailId),
    },
    "task_run.started": {
      trigger,
      task_revision: taskCount,
      task_grant_id: nullable(detailId),
      environment,
      deadline_at: taskInstant,
    },
    "task_run.waiting": {
      state: runState,
      waiting_reason: oneOf(TASK_DETAIL_VOCABULARY.waiting_reasons),
      turns_used: taskCount,
    },
    "task_run.resumed": { previous_state: runState, resume_reason: code, turns_used: taskCount },
    "task_run.result_ready": { turns_used: taskCount },
    "task_run.completed": {
      previous_state: runState,
      turns_used: taskCount,
      duration_ms: taskCount,
    },
    "task_run.failed": {
      previous_state: runState,
      failure_code: code,
      turns_used: taskCount,
      duration_ms: taskCount,
    },
    "task_run.abort_requested": { previous_state: runState },
    "task_run.aborted": {
      previous_state: runState,
      turns_used: taskCount,
      duration_ms: taskCount,
    },
  };
}

let taskDetailChecks: Record<string, Record<string, DetailCheck>> | null = null;

function taskDetails(entry: AuditEntry): Record<string, Detail> | null {
  taskDetailChecks ??= buildTaskDetailChecks();
  if (!Object.hasOwn(taskDetailChecks, entry.action)) return null;
  const checks = taskDetailChecks[entry.action] ?? {};
  const details: Record<string, Detail> = {};
  for (const [field, check] of Object.entries(checks)) {
    if (!Object.hasOwn(entry.metadata, field)) continue;
    const value = check(entry.metadata[field]);
    if (value !== undefined) details[field] = value;
  }
  if (entry.action === "task.authority_granted" || entry.action === "task.authority_revoked") {
    for (const list of TASK_GRANT_ID_LISTS) {
      const value = entry.metadata[list];
      if (Array.isArray(value) && value.length <= TASK_ID_LIST_LIMIT) {
        details[`${list.slice(0, -"_ids".length)}_count`] = value.length;
      }
    }
  }
  return details;
}

function recordedDetails(entry: AuditEntry): Record<string, string | number | boolean | null> {
  const task = taskDetails(entry);
  if (task) return task;
  const device = deviceDetails(entry);
  if (device) return device;
  const fields = DETAIL_FIELDS[entry.action] ?? [];
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (!Object.hasOwn(entry.metadata, field)) return [];
      const raw = entry.metadata[field];
      const value = ID_DETAIL_FIELDS.has(field) ? (recordedId(raw) ?? undefined) : detailValue(raw);
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
  const accessType =
    AUDIT_ACCESS_TYPES.find((type) => type === entry.metadata.audit_access_type) ?? null;
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
  const taskId =
    entry.resource_type === "task"
      ? recordedId(entry.resource_id)
      : recordedId(entry.metadata.task_id);
  const taskRunId =
    entry.resource_type === "task_run"
      ? recordedId(entry.resource_id)
      : recordedId(entry.metadata.task_run_id);
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
  const policySource = approvalPolicySource(entry);
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
    task_id: taskId,
    task_run_id: taskRunId,
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
      ...(taskId ? { task_id: taskId } : {}),
      ...(taskRunId ? { task_run_id: taskRunId } : {}),
      ...(policySource ? { source: policySource } : {}),
    },
  };
}
