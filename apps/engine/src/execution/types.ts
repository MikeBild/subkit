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

export type StepWarningCode = "unresolved_identifier";

export interface StepWarning {
  code: StepWarningCode;
  /** Concrete identifier / placeholder path that could not be resolved. */
  identifier?: string;
  message: string;
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
  }>;
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

export const MAX_CALL_DEPTH = 5;
