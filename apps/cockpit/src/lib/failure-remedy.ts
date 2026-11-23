import type { CauseClass } from "@/lib/cause-class";
import type { RemedyKind } from "@/lib/remedy";

export type FailureRemedyKind = Extract<
  RemedyKind,
  "retry" | "sign_in" | "reconnect" | "grant" | "chat" | "admin"
>;

export interface ErrorFacts {
  status: number | null;
  code: string | null;
  traceId: string | null;
}

export interface FailureFacts {
  status: number | null;
  code: string | null;
  causeClass: string | null;
  workflowId: string | null;
  connectorId: string | null;
}

const BY_CAUSE: Record<CauseClass, FailureRemedyKind | null> = {
  ok: null,
  auth_failed: "reconnect",
  authority_mismatch: "grant",
  refused_before_start: "grant",
  timeout: "retry",
  aborted: "retry",
  connector_unavailable: "retry",
  rate_limited: "retry",
  incomplete_read: "retry",
  driver_error: "retry",
  budget_exhausted: "admin",
  connector_missing: "chat",
  placeholder_unresolved: "chat",
  schema_mismatch: "chat",
  payload_invalid: "chat",
  preview_unsupported: "chat",
  unknown: "chat",
};

const BY_CODE: Record<string, FailureRemedyKind> = {
  unauthorized: "sign_in",
  installation_session_required: "sign_in",
  cockpit_installation_session_required: "sign_in",
  browser_session_required: "sign_in",
  human_session_required: "sign_in",
  csrf_rejected: "sign_in",
  installation_revoked: "sign_in",
  connector_needs_sign_in_again: "reconnect",
  execution_authentication_unavailable: "reconnect",
  execution_authority_required: "grant",
  execution_authority_expired: "grant",
  execution_authority_exhausted: "grant",
  execution_authority_revoked: "grant",
  execution_authority_changed: "grant",
  execution_boundary_mismatch: "grant",
  authority_manifest_changed: "grant",
  task_grant_fingerprint_changed: "grant",
  human_confirmation_required: "grant",
  environment_mismatch: "grant",
  forbidden: "admin",
  scope_violation: "admin",
  workspace_admin_required: "admin",
  operator_required: "admin",
  task_run_write_forbidden: "admin",
  sensitive_resume_forbidden: "admin",
  product_preparation_forbidden: "admin",
  hosted_storage_quota_exhausted: "admin",
  hosted_file_quota_exhausted: "admin",
  request_quota_exhausted: "admin",
  llm_key_required: "admin",
  llm_key_rejected: "admin",
  llm_access_not_stored: "admin",
  ai_access_missing: "admin",
  rate_limit_exceeded: "retry",
  rate_limited: "retry",
  llm_provider_limited: "retry",
  llm_provider_unreachable: "retry",
  llm_provider_unavailable: "retry",
  llm_probe_rate_limited: "retry",
  connector_timeout: "retry",
  turn_busy: "retry",
  busy: "retry",
  internal_error: "retry",
  internal: "retry",
  remote_error: "retry",
  conflict: "retry",
  revision_conflict: "retry",
  version_conflict: "retry",
  intake_items_changed: "retry",
  tenant_context_changed: "retry",
  connector_missing: "chat",
  connector_switched_off: "chat",
  input_schema_violation: "chat",
  output_schema_violation: "chat",
  output_transform_failed: "chat",
  unresolved_identifier: "chat",
  workflow_version_unavailable: "chat",
  workflow_version_not_active: "chat",
};

function byStatus(status: number | null): FailureRemedyKind | null {
  if (status === null) return null;
  if (status === 401) return "sign_in";
  if (status === 403) return "admin";
  if (status === 0 || status === 408 || status === 409 || status === 429 || status >= 500)
    return "retry";
  return null;
}

export function failureRemedy(
  facts: Pick<FailureFacts, "status" | "code" | "causeClass">,
): FailureRemedyKind | null {
  if (facts.causeClass && Object.hasOwn(BY_CAUSE, facts.causeClass))
    return BY_CAUSE[facts.causeClass as CauseClass];
  if (facts.code && Object.hasOwn(BY_CODE, facts.code)) return BY_CODE[facts.code] ?? null;
  return byStatus(facts.status);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function fields(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
}

export function errorFacts(error: unknown): ErrorFacts {
  const record = fields(error);
  return {
    status: typeof record.status === "number" ? record.status : null,
    code: text(record.code),
    traceId: text(record.traceId),
  };
}

export function failureFacts(error: unknown): FailureFacts {
  const { status, code } = errorFacts(error);
  const record = fields(error);
  const details = fields(record.details);
  const network = record.name === "TypeError" || record.name === "TimeoutError";
  return {
    status: status ?? (network ? 0 : null),
    code,
    causeClass: text(details.cause_class),
    workflowId: text(details.workflow_id),
    connectorId: text(details.connector_id),
  };
}
