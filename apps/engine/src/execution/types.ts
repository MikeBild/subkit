// Internal execution types — distinct from the public WorkflowDef in
// apps/engine/src/workflows/types.ts because the engine accumulates extra
// state (scope, db handles, abort, parent chain) that is not part of the
// user-authored DAG.

import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
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
  | "loop_over_unresolved";

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

export interface StepResult {
  status: "succeeded" | "failed" | "aborted" | "timed_out";
  output?: unknown;
  error?: { code: string; message: string; details?: unknown } | null;
  retry_count: number;
  duration_ms: number;
  request_meta?: Record<string, unknown> | null;
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
  | "oauth2_refreshed";

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
    request_meta?: Record<string, unknown> | null;
    /**
     * Truncated preview of the step's output. Populated by the
     * execution engine for every step (the same value persisted to
     * `execution_steps.output_preview`). Surfaces on dry_run_workflow
     * responses so the LLM can author downstream transforms against
     * REAL scope shapes — closes the blind-authoring gap that drove
     * session 3f6082d2's silent format_output failures.
     */
    output_preview?: unknown;
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
