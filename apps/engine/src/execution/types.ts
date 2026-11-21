import type { ResolvedPrincipal } from "../auth/types.ts";
import type { RequestDispatchPolicy } from "../connectors/drivers/http.ts";
import type { ConnectionAuthorityIdentity } from "../credentials/authority-metadata.ts";
import type { Db } from "../db/client.ts";
import type { RunLlmBudget } from "../llm/accounting/index.ts";
import type { ResolvedAuthorityReference } from "../llm/substitution/resolver.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import type { StepDef } from "../workflows/types.ts";
import type { CallerContext } from "./caller-context.ts";
import type { CallerOrigin } from "./caller-origin.ts";
import type { Clock, IdGen } from "./clock.ts";
import type { ExecutionStatus, StepStatus } from "./core/status.ts";
import type { MaterializedRequest } from "./prepared-request.ts";

export type ExecutionSourceKind = "saved" | "draft" | "step";

export type { RequestSource };

export type ExecutionMode = "dev" | "prod";

export type { ExecutionStatus, StepStatus } from "./core/status.ts";

export interface RequestAuthoritySnapshot {
  referenced_authorities?: ResolvedAuthorityReference[];
  step_row_id?: string;
  connector_id?: string | null;
  requires_review?: boolean;
  request_max_attempts?: number;
  requires_transactional_authority?: boolean;
  outbox_source?: { ok: boolean; recipient: unknown; item_id: unknown };
  principal_id?: string | null;
  request?: MaterializedRequest;
  step_id: string;
  configuration_digest: string;
  credential_id: string | null;
  credential_revision: number | null;
  connection_authority: ConnectionAuthorityIdentity | null;
}

interface ExecutionContext {
  execution_privacy?: "sensitive" | undefined;
  prepared_workflow_references?: ResolvedAuthorityReference[];
  before_external_request?: (
    snapshot: RequestAuthoritySnapshot,
  ) => Promise<RequestDispatchPolicy | undefined>;
  db: Db;
  tenant_id: string;
  execution_id: string;
  workflow_id: string;
  workflow_version_id: string;
  request_source: RequestSource;
  parent_execution_id: string | null;
  depth: number;
  signal: AbortSignal;
  scope: Record<string, unknown>;
  started_at: Date;
  evaluation_seed?: string;
  workflow_slug: string;
  trace_id: string | null;
  principal?: ResolvedPrincipal | null;
  caller_context?: CallerContext | null;
  caller_origin?: CallerOrigin;
  execution_mode: ExecutionMode;
  llm_budget: RunLlmBudget;
  hold_writes?: boolean;
  own_connector_credentials?: boolean;
  persist_workflow_refs: boolean;
  workflow_deadline_ms?: number;
  clock?: Clock;
  ids?: IdGen;
}

export interface StepRunContext extends ExecutionContext {
  step: StepDef;
  step_index: number;
  step_row_id: string;
}

export type StepWarningCode =
  | "unresolved_identifier"
  | "loop_body_empty"
  | "transform_empty_extraction"
  | "transform_dropped_fields"
  | "loop_over_unresolved"
  | "branch_when_unresolved"
  | "pagination_truncated"
  | "output_contract_violation"
  | "graphql_partial_errors"
  | "mcp_remote_error"
  | "step_failed_continued"
  | "held_preview_no_writes";

export const HELD_PREVIEW_WARNING_CODE = "held_preview_no_writes" as const;

export function hasHeldOutput(result: StepResult): boolean {
  return (
    result.held === true ||
    (result.warnings?.some((warning) => warning.code === HELD_PREVIEW_WARNING_CODE) ?? false)
  );
}

export interface StepWarning {
  code: StepWarningCode;
  identifier?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RequestDigest {
  header_keys: string[];
  query_keys: string[];
  body_kind: string;
}

export interface PaginationCheckpoint {
  page_idx: number;
  accumulated_count: number;
  signature: string;
}

export interface RequestPaginationSummary {
  strategy: "offset" | "page" | "cursor" | "link";
  pages: number;
  items: number;
  duplicates_dropped: number;
  complete: boolean;
  truncated: boolean;
  limit: "max_pages" | "max_items" | "max_bytes" | null;
  rereads?: number;
}

export type RequestMeta =
  | {
      driver: "http";
      method: string;
      url: string | null;
      status?: number;
      bytes_in?: number;
      bytes_out?: number;
      idempotency_key?: string;
      connector: ConnectorResolutionSummary;
      unresolved_placeholders?: string[];
      digest?: RequestDigest;
      pages_fetched?: number;
      resumed_from_page?: number;
      resumed_accumulated_count?: number;
      pagination_checkpoint?: PaginationCheckpoint;
      pagination?: RequestPaginationSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "graphql";
      method: string;
      status: number;
      connector: ConnectorResolutionSummary;
      operation_name?: string;
      pagination?: RequestPaginationSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "postgres";
      query_preview: string;
      row_count: number | null;
      transaction: boolean;
      cursor: boolean;
      connector: ConnectorResolutionSummary;
      row_count_per_statement?: Array<number | null>;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "s3";
      method: string;
      status?: number;
      refused?: true;
      key?: string;
      prefix?: string;
      bytes_out?: number;
      connector: ConnectorResolutionSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "mcp";
      operation: string;
      bytes_in: number;
      tool_name?: string;
      connector: ConnectorResolutionSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "connectorless";
      method: string;
      url: string | null;
      status?: number;
      bytes_in?: number;
      bytes_out?: number;
      idempotency_key?: string;
      unresolved_placeholders?: string[];
      digest?: RequestDigest;
      pages_fetched?: number;
      resumed_from_page?: number;
      resumed_accumulated_count?: number;
      pagination_checkpoint?: PaginationCheckpoint;
      pagination?: RequestPaginationSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "error";
      method?: string;
      url?: string | null;
      unresolved_placeholders?: string[];
      digest?: RequestDigest;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "sensitive";
      pagination: RequestPaginationSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "sandbox";
      ticks: number;
      duration_ms: number;
      peak_memory_bytes: number | null;
      extras?: Record<string, unknown>;
    };

export interface StepErrorDetail {
  code: string;
  message: string;
  kind?: string;
  details?: unknown;
  resolved_url?: string;
  resolved_placeholders?: Array<{ name: string; preview: string }>;
  upstream_status?: number;
  response_body_excerpt?: string;
  response_headers?: Record<string, string>;
  health?: string;
  health_error_code?: string;
  guidance?: string;
  next_best_actions?: string[];
  reason?: string;
}

export interface HeldRequest {
  method: string;
  url: string | null;
  headers_redacted: Record<string, string>;
  body: unknown;
}

export interface StepResult {
  status: "succeeded" | "failed" | "aborted" | "timed_out" | "skipped";
  held?: true;
  held_request?: HeldRequest;
  output?: unknown;
  error?: StepErrorDetail | null;
  retry_count: number;
  duration_ms: number;
  request_meta?: RequestMeta | null;
  warnings?: StepWarning[];
}

export interface RunOptions {
  execution_privacy?: "sensitive" | undefined;
  resume_authorized?: boolean;
  request_source?: RequestSource;
  parent_execution_id?: string | null;
  authority_link?: { root_execution_id: string; call_path: string[] } | null;
  depth?: number;
  signal?: AbortSignal;
  trace_id?: string | null;
  principal?: ResolvedPrincipal | null;
  caller_context?: CallerContext | null;
  caller_origin?: CallerOrigin;
  execution_mode?: ExecutionMode;
  existing_execution_id?: string;
  tool_approval_id?: string;
  idempotency_key?: string | null;
  self_healing?: { enabled: boolean };
  hold_writes?: boolean;
  sensitive_metadata_preview?: boolean;
  step_output_fixtures?: Record<string, unknown>;
  budget_resume?: Record<string, unknown>;
}

export type SensitiveCheckVerdict = "passed" | "failed" | "not_defined" | "not_run";

export interface SensitiveOutputField {
  type: "string" | "number" | "boolean" | "null" | "array" | "object" | "missing";
  length?: number;
}

export interface SensitivePreviewChecks {
  validation: SensitiveCheckVerdict;
  output_schema: SensitiveCheckVerdict;
  output_shape: Record<string, SensitiveOutputField>;
}

export type AppliedAuthMethod =
  | "none"
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2_static"
  | "oauth2_refreshed"
  | "aws_sigv4"
  | "token_mint_static"
  | "token_mint_refreshed"
  | "oauth2_client"
  | "oauth2_private_key"
  | "signed_jwt";

export interface ConnectorResolutionSummary {
  step_key: string;
  connector_id: string;
  connector_slug: string;
  driver: string;
  requested_environment: ExecutionMode;
  resolved_environment: ExecutionMode;
  auth_method: AppliedAuthMethod;
  base_url?: string | null;
}

export interface RunResult {
  execution_id: string;
  status: ExecutionStatus;
  output: unknown;
  error: { code: string; message: string } | null;
  steps: Array<{
    step_key: string;
    step_index: number;
    kind: string;
    status: StepStatus;
    duration_ms: number | null;
    retry_count: number;
    error: unknown;
    request_meta?: RequestMeta | null;
    held?: true;
    held_request?: HeldRequest;
    output_preview?: unknown;
    raw_preview?: unknown;
  }>;
  connector_resolutions?: ConnectorResolutionSummary[];
  warnings?: Array<StepWarning & { step_key: string }>;
  sensitive_checks?: SensitivePreviewChecks;
}
