// Internal execution types — distinct from the public WorkflowDef in
// apps/engine/src/workflows/types.ts because the engine accumulates extra
// state (scope, db handles, abort, parent chain) that is not part of the
// user-authored DAG.

import type { ResolvedPrincipal } from "../auth/types.ts";
import type { RequestDispatchPolicy } from "../connectors/drivers/http.ts";
import type { ConnectionAuthorityIdentity } from "../credentials/authority-metadata.ts";
import type { Db } from "../db/client.ts";
import type { RunLlmBudget } from "../llm/accounting/index.ts";
import type { ResolvedAuthorityReference } from "../llm/substitution/resolver.ts";
// The single canonical RequestSource, derived from the Zod RequestSourceSchema.
import type { RequestSource } from "../observability/service-metadata.ts";
import type { StepDef, WorkflowDef } from "../workflows/types.ts";
import type { MaterializedRequest } from "./prepared-request.ts";

/** Discriminates how the execution definition was sourced.
 *  Persisted verbatim into `executions.source_kind`. */
export type ExecutionSourceKind = "saved" | "draft" | "step";

// Re-export the canonical RequestSource so this module's many consumers keep
// importing it from here, but can never drift from the wire enum again. A
// hand-maintained copy here previously lagged by two members ("ui", "queue").
export type { RequestSource };

export type ExecutionMode = "dev" | "prod";

export type StepStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "timed_out"
  | "skipped";

/** Top-level execution status persisted to `executions.status` (DB enum).
 *  Excludes `"skipped"` — an entire execution is never skipped, only
 *  individual steps within it can be. */
export type ExecutionStatus = Exclude<StepStatus, "skipped">;

export interface RequestAuthoritySnapshot {
  referenced_authorities?: ResolvedAuthorityReference[];
  step_row_id?: string;
  connector_id?: string | null;
  requires_review?: boolean;
  request_max_attempts?: number;
  principal_id?: string | null;
  request?: MaterializedRequest;
  step_id: string;
  configuration_digest: string;
  credential_id: string | null;
  credential_revision: number | null;
  connection_authority: ConnectionAuthorityIdentity | null;
}

export interface ExecutionContext {
  /** Server-captured metadata for every static credential/connector dependency,
   * including earlier reads and transforms in a prepared single-run flow. */
  prepared_workflow_references?: ResolvedAuthorityReference[];
  /** Server-owned guard, repeated after credential resolution and before each
   * outbound request attempt. Never part of an authored workflow definition. */
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
  // Mutable scope: keys are step ids, values are step outputs
  scope: Record<string, unknown>;
  // Per-execution counters
  started_at: Date;
  /** Server-bound preparation seed for an approved replay. */
  evaluation_seed?: string;
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
  /** Hold-writes preview mode — threaded from `RunOptions.hold_writes`
   *  so the request driver can hold write-classified dispatches. Only
   *  set (to `true`) when the run was started with `hold_writes`. */
  hold_writes?: boolean;
  /** Whether `workflow_id` / `workflow_version_id` name rows that actually
   *  exist. False for draft and single-step runs, whose ids are synthesised
   *  by `resolveDefinition` and deliberately NOT persisted onto the
   *  `executions` row. Any driver writing `workflow_id` into a table with an
   *  FK to `workflows` MUST consult this first — a synthetic id violates the
   *  constraint and crashes the step. Mirrors
   *  `ResolvedDefinition.persist_workflow_refs`. */
  persist_workflow_refs: boolean;
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
  | "branch_when_unresolved"
  // Emitted by the paginated request driver when the accumulated page
  // bodies hit the in-memory byte cap and pagination stopped early.
  // Without the cap a single step could buffer MAX_PAGES × large-page
  // bodies (observed: 545KB pages → multi-GB RSS) and stall/kill the
  // engine; with it the step returns the bounded prefix plus this
  // warning naming how much was fetched and how to narrow the query.
  | "pagination_truncated"
  // Emitted by the engine when the FINAL workflow output fails the
  // definition's `output_schema` contract (Fix 11). NON-blocking on
  // live runs — the run still succeeds and the warning (with the
  // field-level `$output/...` paths in `details.violations`) rides the
  // run result. `dry_run_workflow` treats the same code as a blocking
  // repair warning so a contract-violating draft never auto-commits.
  // `step_key` is the sentinel "$output" (workflow-level, no step).
  | "output_contract_violation"
  // Emitted by the graphql driver when error_policy:"all" is set and the
  // response carries both data and errors. The step succeeds; errors surface
  // here so the operator sees them without the step failing.
  | "graphql_partial_errors"
  // Emitted by the mcp driver when error_policy:"all" is set and the remote
  // reported the call itself failed. The step succeeds carrying whatever the
  // server returned; the error text surfaces here so the operator sees it.
  | "mcp_remote_error"
  // Emitted by the engine when a step fails but declared
  // on_error:"continue". The run continues and status stays succeeded;
  // the failure surfaces here instead of on RunResult.error. This is
  // author-declared tolerance — consumers must NOT treat it as
  // requires_repair.
  | "step_failed_continued"
  // Emitted by the engine when a hold-writes preview held a write step (or
  // skipped a step behind a held write) and NOTHING was persisted. The run
  // still succeeds; this MANDATORY warning tells the caller the returned
  // output is an upstream read/transform value and that no external write
  // happened. It states the STATE, never the remedy — naming the remedy is
  // the tool surface's job (it owns the argument or approval handle that
  // releases the writes). `step_key` is the sentinel "$holds"; `details`
  // carries held_steps / skipped_steps / would_write. Prevents the
  // "reported ≠ written" silent no-op.
  | "held_preview_no_writes";

/** The warning above as a value. The engine emits it; every tool surface that
 *  lifts a held run into a preview envelope keys off this one constant. */
export const HELD_PREVIEW_WARNING_CODE = "held_preview_no_writes" as const;

/** A step whose write was held: it produced a preview, not an effect. One
 *  predicate for the engine's skip bookkeeping and the persisted step row. */
export function hasHeldOutput(result: StepResult): boolean {
  return (
    result.held === true ||
    (result.warnings?.some((warning) => warning.code === HELD_PREVIEW_WARNING_CODE) ?? false)
  );
}

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
  /** Hash of URL, query, body and pagination configuration. */
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
      /** How much this request SENT, measured at dispatch. */
      bytes_out?: number;
      idempotency_key?: string;
      connector: ConnectorResolutionSummary;
      unresolved_placeholders?: string[];
      /** Audit-safe digest of headers + query + body kind. */
      digest?: RequestDigest;
      /** Number of pages walked during pagination. Absent on
       *  non-paginated requests. */
      pages_fetched?: number;
      /** Legacy diagnostic field retained for API compatibility. */
      resumed_from_page?: number;
      /** Legacy diagnostic field retained for API compatibility. */
      resumed_accumulated_count?: number;
      /** Progress checkpoint; retries restart at page 1 for complete output. */
      pagination_checkpoint?: PaginationCheckpoint;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "graphql";
      method: string;
      status: number;
      connector: ConnectorResolutionSummary;
      /** Operation name parsed from the query document — the anchor
       *  for shape recording and the repair endpoint key. */
      operation_name?: string;
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
      /** Absent when the request never reached the store because a boundary
       *  refused it — there is no status to report, and inventing one would
       *  make the trail claim a call that did not happen. */
      status?: number;
      /** True exactly for that refusal, so a reader can tell "did not run"
       *  from "ran and failed". */
      refused?: true;
      key?: string;
      prefix?: string;
      /** How large the content really was, measured at the write. */
      bytes_out?: number;
      connector: ConnectorResolutionSummary;
      extras?: Record<string, unknown>;
    }
  | {
      driver: "mcp";
      /** The MCP method issued: `tools/call`, `resources/read` or
       *  `prompts/get`. No `status` — a JSON-RPC result has none, and
       *  inventing one would make the trail lie about what was observed. */
      operation: string;
      /** Raw byte count of the verbatim remote content. */
      bytes_in: number;
      /** Model-facing `mcp_<slug>__<tool>` name, on tool calls only. */
      tool_name?: string;
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
      /** How much this request SENT, measured at dispatch. */
      bytes_out?: number;
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
  /** Driver-tagged failure class the drift detector branches on
   *  (e.g. "graphql_schema_error"). Structured evidence for the
   *  tagged class rides in `details`. */
  kind?: string;
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
  /** Connector-health verdict for the failing response
   *  (auth_failed | endpoint_gone | not_found | rate_limited | degraded). */
  health?: string;
  /** Stable machine code from the health hint (endpoint_removed | ...). */
  health_error_code?: string;
  /** Actionable human/LLM guidance — "endpoint removed, check docs for the
   *  replacement", "'x' may be a user, try /users/x" — instead of a bare
   *  `http 410`. */
  guidance?: string;
  /** Tool names the LLM should reach for next (fetch_connector_docs, ...). */
  next_best_actions?: string[];
}

/**
 * Materialized-but-not-dispatched request artifact produced by
 * hold-writes mode (`RunOptions.hold_writes`). The request is fully
 * RESOLVED — placeholders substituted against the live upstream scope,
 * connector base URL + credential headers applied, body shaped exactly
 * as dispatch would have sent it — and recorded here INSTEAD of
 * crossing the wire.
 *
 * Representation contract (the dry-run preview / judge consume this):
 *  - the holding step reports `status: "succeeded"` with `held: true`
 *    on its StepResult / RunResult step summary — NOT a new status
 *    value. The StepStatus union and the persisted
 *    `execution_steps.status` stay unchanged, `on_error` semantics
 *    never fire for a held step, and the preview layer narrows on the
 *    explicit `held` flag instead of a status string.
 *  - `body` is NOT redacted — it is the artifact the judge must read
 *    (the would-be email HTML, the post payload).
 *  - `headers_redacted` keeps every header NAME; secret-bearing values
 *    (authorization / cookie / x-api-key / … — the same denylist the
 *    error-detail header scrub uses) are masked, and the remaining
 *    values pass through the shared secret scrubber.
 */
export interface HeldRequest {
  method: string;
  /** Fully resolved URL for the http driver, the object path for the
   *  s3 driver, `null` for postgres. */
  url: string | null;
  headers_redacted: Record<string, string>;
  /** Driver-shaped resolved payload: HTTP → the resolved JSON body;
   *  graphql → `{ query, variables? }`; postgres →
   *  `{ query, params, also? }`; s3 → the resolved object body.
   *  `null` when the request carries none. */
  body: unknown;
}

export interface StepResult {
  status: "succeeded" | "failed" | "aborted" | "timed_out" | "skipped";
  /** Hold-writes mode: true when this write-classified step was fully
   *  resolved but NOT dispatched. Always paired with `held_request`
   *  and `status: "succeeded"`. `output` is null — the engine skips
   *  dependents explicitly instead of feeding them artifact data. */
  held?: true;
  held_request?: HeldRequest;
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
  /** Server-owned. Set only by `runCallStep` when an APPROVED run reaches a
   *  `call` step whose target its approval pins. The started run holds no
   *  approval of its own and is measured against the root's at this path. */
  authority_link?: { root_execution_id: string; call_path: string[] } | null;
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
  /** Server-owned consumed approval; never exposed as a model/API run option. */
  tool_approval_id?: string;
  /**
   * Caller-chosen key that makes this trigger safe to repeat. Persisted on
   * the execution row under a per-tenant unique index; the HTTP layer turns
   * a collision into a replay of the first run.
   */
  idempotency_key?: string | null;
  /**
   * Per-call override for self-healing. When unset the engine uses the
   * tenant policy (`resolvePolicy()`); set explicitly when the eval
   * runner needs to compare `mode=one_shot` against `mode=self_healing`,
   * or when an operator wants to dry-run a workflow without triggering
   * drift detection.
   */
  self_healing?: { enabled: boolean };
  /**
   * Side-effect-safe preview mode (Fix G). When true, request-class
   * writes and unknown effects (including every SQL statement and HTTP
   * POST, even if labelled `side_effects: "read"`) are fully resolved — URL, headers,
   * body materialized from real upstream data — and recorded as
   * `held` on the step result; the network call never fires. Steps
   * whose scope references depend on a held step's response are
   * skipped with the labeled `skipped_dependency_held` error instead
   * of failing on unresolved placeholders. Read steps execute live,
   * exactly as without the flag. Propagates into `call`-step child
   * executions so a child workflow cannot leak a write. Default
   * (unset/false): behavior unchanged.
   */
  hold_writes?: boolean;
  /**
   * Per-step output fixtures. When set, the engine skips executing any
   * step whose id appears in this map and uses the cached envelope
   * instead. Used by the dry-run cache to avoid re-hitting an unchanged
   * upstream when only a downstream transform was edited. The cached
   * envelope must already include the documented `{ data, status_code?,
   * headers?, duration_ms, error? }` shape that `envelopeFor` produces;
   * the engine writes it verbatim into the scope object.
   *
   * Restrictions:
   *  - Only safe for deterministic step kinds (`request` GETs,
   *    `graphql` queries, `transform`). Callers are responsible for
   *    excluding side-effectful steps (POST/PUT/DELETE, write-mode
   *    queries) — the engine does NOT introspect step config to decide.
   *  - The map is consulted before each step in linear walk order. A
   *    miss falls through to normal execution; subsequent hits keep
   *    working. This makes partial-prefix replay correct by
   *    construction.
   */
  step_output_fixtures?: Record<string, unknown>;
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
  | "token_mint_refreshed"
  // Machine-to-machine OAuth2. `oauth2_client` is the client-credentials
  // grant, `oauth2_private_key` the private-key-JWT one. Distinct from
  // `oauth2_static` / `oauth2_refreshed`, which describe a token minted by
  // a user-consented authorization-code flow.
  | "oauth2_client"
  | "oauth2_private_key";

/** Per-connector rollup in `RunResult.connector_resolutions`. One entry per
 *  unique (step_key, connector_id) pair — lets debuggers see at a glance
 *  which driver / auth / environment each step actually used. */
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
    /** Hold-writes preview: the step was write-classified and its
     *  request was materialized but NOT dispatched. The step status is
     *  `"succeeded"` — narrow on this flag. See `HeldRequest`. */
    held?: true;
    /** The materialized request artifact for a held step — the payload
     *  the judge evaluates BEFORE anything is sent. */
    held_request?: HeldRequest;
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
