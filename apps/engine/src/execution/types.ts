// Internal execution types — distinct from the public WorkflowDef in
// apps/engine/src/workflows/types.ts because the engine accumulates extra
// state (scope, db handles, abort, parent chain) that is not part of the
// user-authored DAG.

import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import type { RunLlmBudget } from "../llm/accounting/index.ts";
import type { StepDef, WorkflowDef } from "../workflows/types.ts";

/** Discriminates how the execution definition was sourced.
 *  Persisted verbatim into `executions.source_kind`. */
export type ExecutionSourceKind = "saved" | "draft" | "step";

export type RequestSource = "api" | "cli" | "mcp" | "webhook" | "tool-chain" | "scheduler" | "chat";

export type ExecutionMode = "dev" | "prod";

export type StepStatus = "queued" | "running" | "succeeded" | "failed" | "aborted" | "timed_out";

export type ExecutionStatus = StepStatus;

export interface ExecutionContext {
  db: Db;
  tenant_id: string;
  execution_id: string;
  workflow_id: string;
  workflow_version_id: string;
  request_source: RequestSource;
  parent_execution_id: string | null;
  depth: number;
  signal: AbortSignal;
  // Mutable scope: keys are step ids, values are step outputs
  scope: Record<string, unknown>;
  // Per-execution counters
  started_at: Date;
  // Workflow definition for nested call lookups
  workflow_slug: string;
  // Logger fields shared by every emitted log line.
  trace_id: string | null;
  // Acting principal, when known (api, mcp, chat, webhook-via-allowlist).
  // Scheduled + tool-chain executions may have no principal.
  principal?: ResolvedPrincipal | null;
  // Target environment for connector resolution. Requests routed through
  // connector_id are rewritten to the matching per-env row when set.
  execution_mode: ExecutionMode;
  /**
   * Per-run LLM-token accumulator. Always present; the cap is null
   * when the workflow definition does not declare
   * `max_llm_tokens_per_run`. Drivers that issue an LLM-provider call
   * (today: HTTP request steps that target a recognised provider host)
   * MUST consult `checkPreCall` before dispatch and `account` after
   * the call returns successfully.
   */
  llm_budget: RunLlmBudget;
}

export interface StepRunContext extends ExecutionContext {
  step: StepDef;
  step_index: number;
  // The active step row id (for offload references).
  step_row_id: string;
}

export type StepWarningCode =
  | "unresolved_identifier"
  | "loop_body_empty"
  // Emitted by runTransformStep when a transform produces empty/null
  // result but upstream scope had non-empty data. Catches the silent
  // failure mode where a JSONata projection over loop output extracts
  // nothing because the path is wrong. The commit gate refuses
  // unacknowledged warnings of this code without force_commit.
  | "transform_empty_extraction"
  // Emitted by runTransformStep when a transform that maps over a
  // non-empty array produces an array of objects whose keys are a
  // STRICT SUBSET of the source iteration's keys — a strong signal
  // the projection silently dropped fields. Pre-fix this caused the
  // session 3f6082d2 failure: format_output mapped over a loop output
  // with body keys (extract, fetch_resources) and emitted
  // [{project_id, project_name}] only — the resources field was
  // silently dropped. The commit gate refuses unacknowledged warnings
  // without force_commit.
  | "transform_dropped_fields"
  // Emitted by the loop driver when its `over` expression evaluates
  // to a non-array (undefined, null, scalar, plain object). Pre-fix
  // the loop silently returned [] and the LLM authored 9× variants
  // of the same broken `over` path (session 86de186b). The warning
  // names the resolved type + the scope keys so the LLM can fix the
  // path on the next attempt.
  | "loop_over_unresolved"
  // Emitted by the branch driver when its `when` predicate resolved
  // to undefined AND the expression named a `$scope.X` step id that
  // doesn't exist in scope. Without this signal, branch silently
  // picks "else" every run and the LLM never sees a typo. Carries
  // `did_you_mean` candidates so the next retry can fix the
  // reference.
  | "branch_when_unresolved";

export interface StepWarning {
  code: StepWarningCode;
  /** Concrete identifier / placeholder path that could not be resolved. */
  identifier?: string;
  message: string;
  /**
   * Optional structured payload carrying the actual scope shape and a
   * suggestion. The run_workflow tool surfaces this to the LLM so it
   * can converge in 1 retry instead of guessing JSONata variants.
   */
  details?: Record<string, unknown>;
}

/**
 * Driver-discriminated request metadata. Every dispatch branch in
 * `request.ts` produces exactly one variant; consumers (drift
 * detector, dry-run trace, observability) MUST switch on `.driver` to
 * narrow.
 *
 * Driver-keyed variants (`http` / `graphql` / `postgres` / `s3`)
 * carry a NON-optional `connector` whenever the step routed through
 * a connector. The `connectorless` variant is the fall-through for
 * steps that ran on a raw `url` (no connector_id) and the `error`
 * variant is the fall-through for failures upstream of dispatch
 * (placeholder unresolved, hook errors).
 */
/**
 * Audit-safe digest of the request's headers + query (key names only,
 * never values). Surfaced inline so consumers don't have to dig into
 * an opaque bag.
 */
export interface RequestDigest {
  /** Lowercase header names, sorted, deduped. Values never logged. */
  header_keys: string[];
  /** Query parameter names, sorted, deduped. Values never logged. */
  query_keys: string[];
  /** Coarse classification of the body for diagnostics — `"none"`,
   *  `"array"`, `"object"`, `"string"`, etc. */
  body_kind: string;
}

/**
 * Persisted resume state for a paginated HTTP request. Promoted to a
 * typed field on the http variant so the recovery path can find it
 * without inspecting an opaque `extras` bag.
 */
export interface PaginationCheckpoint {
  /** Logical page index that has been fully consumed. Resume picks
   *  up at `page_idx + 1`. */
  page_idx: number;
  /** Total items accumulated across already-consumed pages. */
  accumulated_count: number;
  /** Hash of `{base_url, path_or_url, query}` so a future resume
   *  rejects when the workflow mutated. */
  signature: string;
}

/**
 * Driver-discriminated request metadata. Every dispatch branch in
 * `request.ts` emits one variant; consumers narrow on `.driver`.
 *
 * The `extras` slot remains for genuinely free-form diagnostic fields
 * (driver-specific telemetry the OpenAPI surface doesn't formally
 * publish). Canonical fields — header_keys digest, pagination state,
 * page count — are first-class on the variants that need them.
 */
export type RequestMeta =
  | {
      driver: "http";
      method: string;
      url: string | null;
      status?: number;
      bytes_in?: number;
      tunnel_target?: string | null;
      idempotency_key?: string;
      connector: ConnectorResolutionSummary;
      unresolved_placeholders?: string[];
      /** Audit-safe digest of headers + query + body kind. */
      digest?: RequestDigest;
      /** Number of pages walked during pagination. Absent on
       *  non-paginated requests. */
      pages_fetched?: number;
      /** Logical page resumed-from when a checkpoint was honored. */
      resumed_from_page?: number;
      /** Item count carried over from the resume checkpoint. */
      resumed_accumulated_count?: number;
      /** Resume cursor persisted alongside this run for crash
       *  recovery. */
      pagination_checkpoint?: PaginationCheckpoint;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "graphql";
      method: string;
      status: number;
      connector: ConnectorResolutionSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "postgres";
      query_preview: string;
      row_count: number | null;
      transaction: boolean;
      cursor: boolean;
      connector: ConnectorResolutionSummary;
      /** Per-statement row counts (only set on transactional paths). */
      row_count_per_statement?: Array<number | null>;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "s3";
      method: string;
      status: number;
      key?: string;
      prefix?: string;
      connector: ConnectorResolutionSummary;
      extras?: Record<string, unknown>;
    }
  | {
      // Raw `url`-driven HTTP request (no connector_id). Same fields
      // as the `http` variant minus the connector resolution.
      driver: "connectorless";
      method: string;
      url: string | null;
      status?: number;
      bytes_in?: number;
      idempotency_key?: string;
      unresolved_placeholders?: string[];
      digest?: RequestDigest;
      pages_fetched?: number;
      resumed_from_page?: number;
      resumed_accumulated_count?: number;
      pagination_checkpoint?: PaginationCheckpoint;
      extras?: Record<string, unknown>;
    }
  | {
      // Pre-dispatch failures (placeholder unresolved, hook errors,
      // schema rejections). Carries the same audit-safe digest the
      // HTTP path produces so operators can trace step intent on
      // failures upstream of the wire call.
      driver: "error";
      method?: string;
      url?: string | null;
      unresolved_placeholders?: string[];
      digest?: RequestDigest;
      extras?: Record<string, unknown>;
    };

/**
 * Structured upstream-failure detail surfaced on `StepResult.error`.
 *
 * Pre-fix the engine collapsed every driver failure to `{ code, message }`,
 * losing the response body, the resolved post-substitution URL, and the
 * resolved-placeholder snapshot. The LLM author saw `http 404` or
 * `[object Object]` in chat and could not tell whether the path was wrong,
 * the credential expired, or a placeholder failed to substitute. These
 * fields are populated by the request / graphql / postgres / s3 drivers
 * on failure and surface verbatim in `RunResult.steps[].error` and the
 * dry-run output the LLM consumes.
 *
 * Privacy: credential placeholders are replaced with `***` previews;
 * cookie / authorization / x-api-key headers are dropped from
 * `response_headers` before persistence.
 */
export interface StepErrorDetail {
  code: string;
  message: string;
  details?: unknown;
  /** Final URL after `${...}` substitution. Absent for non-HTTP drivers. */
  resolved_url?: string;
  /** Resolved placeholder snapshot. `preview` is `***` for `cred.*`. */
  resolved_placeholders?: Array<{ name: string; preview: string }>;
  /** Upstream HTTP status when the failure had a response. */
  upstream_status?: number;
  /** First 4 KB of the upstream response body, string-encoded. */
  response_body_excerpt?: string;
  /** Safe subset of upstream response headers (auth-bearing names dropped). */
  response_headers?: Record<string, string>;
}

export interface StepResult {
  status: "succeeded" | "failed" | "aborted" | "timed_out";
  output?: unknown;
  error?: StepErrorDetail | null;
  retry_count: number;
  duration_ms: number;
  /** Driver-discriminated metadata. See RequestMeta. Strict union —
   *  switch on `.driver` to narrow. */
  request_meta?: RequestMeta | null;
  /** Non-fatal diagnostics that flow to `execution_steps.output_preview`
   *  and bubble onto the final `RunResult.warnings` for the executor
   *  that kicked the run off (MCP, CLI, HTTP). */
  warnings?: StepWarning[];
}

export interface RunOptions {
  request_source?: RequestSource;
  parent_execution_id?: string | null;
  depth?: number;
  signal?: AbortSignal;
  trace_id?: string | null;
  principal?: ResolvedPrincipal | null;
  /**
   * Target environment for connector resolution + `executions.execution_mode`.
   * Defaults to `"dev"` when the caller does not provide a hint. The HTTP
   * layer reads `x-subkit-environment` and the MCP layer reads `_meta.environment`.
   */
  execution_mode?: ExecutionMode;
  /**
   * When the execution row was created upstream (e.g. by the HTTP layer
   * before enqueueing an `execution.run` job), the worker passes the id
   * here so `runExecution` reuses the existing row instead of inserting a
   * new one.
   */
  existing_execution_id?: string;
  /**
   * Per-call override for self-healing. When unset the engine uses the
   * tenant policy (`resolvePolicy()`); set explicitly when the eval
   * runner needs to compare `mode=one_shot` against `mode=self_healing`,
   * or when an operator wants to dry-run a workflow without triggering
   * drift detection.
   */
  self_healing?: { enabled: boolean };
}

/** Auth method actually applied at request time. Distinguishes a static
 *  bearer from one that was just refreshed via OAuth2 token rotation — the
 *  operator reading the run result can tell whether credentials are fresh. */
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
  | "token_mint_refreshed";

/** Per-connector rollup in `RunResult.connector_resolutions`. One entry per
 *  unique (step_key, connector_id) pair — lets debuggers see at a glance
 *  which driver / auth / environment / tunnel each step actually used. */
export interface ConnectorResolutionSummary {
  step_key: string;
  connector_id: string;
  connector_slug: string;
  driver: string;
  requested_environment: ExecutionMode;
  resolved_environment: ExecutionMode;
  auth_method: AppliedAuthMethod;
  tunnel_target?: string | null;
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
    /**
     * Truncated preview of the step's output. Populated by the
     * execution engine for every step (the same value persisted to
     * `execution_steps.output_preview`). Surfaces on dry_run_workflow
     * responses so the LLM can author downstream transforms against
     * REAL scope shapes — closes the blind-authoring gap that drove
     * session 3f6082d2's silent format_output failures.
     */
    output_preview?: unknown;
    /**
     * Pre-data_selector raw envelope. Only present when the step had
     * a `data_selector` and the resulting `output_preview` is the
     * post-selector slice. Lets the LLM see what the selector
     * dropped (so it can fix the path or remove the selector)
     * without re-running. Truncated identically to `output_preview`.
     */
    raw_preview?: unknown;
  }>;
  /** One entry per unique connector used in this run. Deduped per
   *  connector_id, first occurrence wins. Absent when no request/graphql
   *  step touched a connector. */
  connector_resolutions?: ConnectorResolutionSummary[];
  /** Non-fatal diagnostics rolled up from every step. Present when
   *  at least one step emitted a warning (typically jsonata
   *  `unresolved_identifier`). Absent when the run had none. */
  warnings?: Array<StepWarning & { step_key: string }>;
}

export interface RunInput {
  workflow: {
    id: string;
    tenant_id: string;
    slug: string;
    version_id: string;
    def: WorkflowDef;
  };
  input: unknown;
  options: RunOptions;
}
