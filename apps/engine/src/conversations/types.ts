// Conversation types shared across the service, loop, tool palette,
// and HTTP / MCP layers.

import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import type { AuthType, DriverName, Environment } from "../connectors/types.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import type { Citation } from "./citations.ts";

export type ConversationStatus = "active" | "awaiting_input" | "committed" | "abandoned";
/**
 * Client-advertised permission mode for a conversation turn.
 *
 *   - `ask`  — every tenant_write tool stops on a confirmation gate.
 *   - `plan` — same UX as `ask`; the assistant proposes work without
 *     auto-executing destructive tools.
 *   - `auto` — non-dangerous tools auto-confirm; `delete_*` /
 *     `revoke_*` / `approve_*` (see `dangerous-tools.ts`) still gate.
 *   - `yolo` — non-sticky escape hatch that lifts the dangerous-tool
 *     gate too. Hard-armed in the client (typed confirmation),
 *     auto-expires after 10 turns / 10 minutes, and never persists
 *     into `draft.session`. A tool executed under yolo is recorded with
 *     `bypassed_confirmation: true` in `conversation_tool_calls.confirmation_data`
 *     (`sdk-wrap/invoke.ts`) and a `tool.executed_yolo` warn log — NOT in the
 *     audit log. Forensics for a yolo write therefore starts at the tool-call
 *     row, not at `audit_log`.
 */
export type ConversationPermissionMode = "auto" | "ask" | "plan" | "yolo";

export type ConversationRole = "user" | "assistant" | "tool" | "system";

export interface ConversationRecord {
  id: string;
  tenant_id: string;
  target_workflow_id: string | null;
  target_connector_id: string | null;
  status: ConversationStatus;
  owner_id: string | null;
  model: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurnUsage {
  /** Tokens consumed by this turn (delta on the llm_usage ledger). */
  turn_tokens: number;
  /**
   * Prompt size of the FINAL LLM call of this turn (uncached input +
   * cache reads + cache writes) — the only per-turn figure that is
   * comparable to `context_cap_tokens`. The CLI's `ctx N/M` gauge MUST
   * use this as numerator: dividing the turn-cumulative token count by
   * the per-prompt cap (the pre-fix behaviour) showed `ctx 464k/180k
   * (100%)` for a turn whose actual prompts were nowhere near the cap.
   * Absent when the turn made no LLM call.
   */
  prompt_tokens_last_call?: number;
  /**
   * Cumulative tokens across every LLM call of this turn (prompt incl.
   * cache + completion, summed per step). Distinct from `turn_tokens`,
   * which is the delta on the llm_usage ledger and may include
   * ancillary flows (critic, suggestions).
   */
  turn_tokens_total?: number;
  /**
   * Remaining token budget for the tenant's current month, or null
   * when the tenant is unlimited.
   */
  remaining_monthly_budget_tokens: number | null;
  /**
   * Effective per-prompt context cap for the model that just ran. The
   * CLI uses this to render a `ctx N/M` gauge in the footer — when the
   * gauge crosses 80% the operator knows to `/compact` before the next
   * turn, instead of discovering the cap by hitting it.
   *
   * Optional because non-Anthropic / mock models report different caps
   * and we don't want the gauge to lie about a 1M-context Claude run
   * when the cap is actually 12k for the in-process mock.
   */
  context_cap_tokens?: number;
  /** Per-section breakdown of the prompt assembled for this turn —
   *  surfaced to the CLI so the operator can see why a turn cost N
   *  tokens (skills vs transcript vs draft). Optional. */
  breakdown?: {
    system: number;
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
    messages: number;
    recipe_bodies: number;
    skill_candidates: number;
    total: number;
  };
}

export interface ConversationMessageRecord {
  id: string;
  conversation_id: string;
  role: ConversationRole;
  content: unknown;
  created_at: string;
}

export interface ConversationToolCallRecord {
  id: string;
  conversation_id: string;
  tool: string;
  input: unknown;
  output: unknown;
  approval_required: boolean;
  created_at: string;
  /**
   * Causal anchor to the assistant message that produced this tool
   * call. Nullable only for legacy or synthetic rows; `messages_v2`
   * ignores unanchored calls rather than guessing their placement.
   */
  parent_message_id?: string | null;
}

export type AuthoringMode =
  | "onboarding"
  | "connector_authoring"
  | "workflow_authoring"
  | "resume_review";

export type AuthoringSurfaceMode = "connector" | "workflow" | "execution" | "diagnosis";

export type AuthoringStage =
  | "idle"
  | "connector_targeted"
  | "connector_draft_started"
  | "connector_inspected"
  | "connector_validated"
  | "connector_authenticated"
  | "connector_probed"
  | "connector_persisted"
  | "workflow_targeted"
  | "workflow_draft_started"
  | "workflow_inspected"
  | "workflow_validated"
  | "workflow_previewed"
  | "workflow_persisted"
  | "workflow_executed"
  | "diagnosing"
  | "repairing";

export type AuthoringLifecycleState = "none" | "draft_only" | "persisted";

export type AuthoringCheckpointKey =
  | "connector_inspected"
  | "connector_validated"
  | "connector_authenticated"
  | "connector_probed"
  | "connector_persisted"
  | "workflow_inspected"
  | "workflow_validated"
  | "workflow_previewed"
  | "workflow_persisted"
  | "workflow_executed"
  | "workflow_diagnosed";

export type AuthoringCheckpointStatus = "missing" | "fresh" | "stale";

export interface AuthoringActiveTarget {
  kind: "connector" | "workflow" | "none";
  name: string | null;
  slug: string | null;
  id: string | null;
  environment: Environment | null;
  lifecycle_state: AuthoringLifecycleState;
}

export interface AuthoringCheckpointRecord {
  key: AuthoringCheckpointKey;
  verified_at: string;
  verified_by_tool: string;
  mutation_seq: number;
  ok?: boolean | null;
  summary?: string | null;
  resource_ref?: {
    kind: "connector" | "workflow" | "execution" | "diagnosis";
    id: string;
    version_id?: string | null;
  } | null;
}

export interface AuthoringCheckpointView {
  key: AuthoringCheckpointKey;
  status: AuthoringCheckpointStatus;
  verified_at: string | null;
  verified_by_tool: string | null;
  ok: boolean | null;
  summary: string | null;
}

export interface PersistedResourceRef {
  kind: "connector" | "workflow";
  id: string;
  slug: string | null;
  name: string | null;
  version_id: string | null;
  version: number | null;
  environment: Environment | null;
  saved_at: string;
}

export interface LatestExecutionSummary {
  execution_id: string;
  workflow_id: string | null;
  workflow_version_id: string | null;
  /** May be a DB-enum status (`succeeded`, `failed`, …) or a CLI-only
   *  classifier (`partial_success`) when the run technically succeeded
   *  but produced suspicious output. The DB row stores the enum value;
   *  this field carries the more granular classification for the LLM
   *  and CLI surfaces. */
  status: string;
  environment: Environment;
  warnings_count: number;
  recorded_at: string;
  diagnosis_available: boolean;
  /** Set when the execution had `unresolved_identifier` warnings or
   *  ran a `loop` step body that produced no output. The
   *  `save_workflow_draft` tool refuses to advance until this flag
   *  is cleared (by repair) or explicitly suppressed via
   *  `acknowledge_warning`. */
  requires_repair?: boolean;
}

export interface DiagnosisStepSummary {
  step_key: string;
  kind: string;
  status: string;
  duration_ms: number | null;
  output_preview?: unknown;
  error?: unknown;
  request_meta?: unknown;
}

export interface LatestDiagnosisSummary {
  execution_id: string;
  recorded_at: string;
  reason: string;
  warning_sources: Array<{
    step_key: string;
    code: string;
    identifier: string | null;
  }>;
  steps: DiagnosisStepSummary[];
}

/**
 * One judged verdict memoized against the definition fingerprint it was
 * computed for (P3). If the current definition fingerprint + goal still
 * match this entry, the judge LLM call is SKIPPED and this verdict is
 * reused — an unchanged re-preview never re-judges.
 */
export interface JudgeVerdictMemo {
  /** Whole-definition fingerprint (sha256[:16] of the canonical JSON)
   *  this verdict was computed against. */
  fingerprint: string;
  verdict: "passes" | "partial" | "failed";
  reason: string;
  missing: string[];
}

/**
 * Anti-churn guard for the instruction-grounded preview judge (Fix C /
 * P3). The breaker now counts **blocks since the last successful
 * commit** — a MONOTONIC per-draft counter, NOT per-fingerprint. It
 * increments on every block regardless of whether the model edited the
 * definition in between (an edit changes the fingerprint but does NOT
 * reset the counter), and resets to 0 only when a workflow actually
 * commits. After `JUDGE_BREAKER_MAX_BLOCKS` blocks the verdict degrades
 * to advisory (attached + logged, non-blocking → auto-commit proceeds),
 * so a model churning edits still converges instead of looping forever.
 *
 * `last_verdict` memoizes the most recent judged verdict against its
 * fingerprint so an unchanged re-preview skips the judge LLM call.
 */
export interface JudgeBreakerState {
  /** Consecutive judge blocks since the last successful commit. Reset
   *  to 0 only on commit (or explicit force-commit), never on a mere
   *  edit. */
  blocks_since_commit: number;
  /** Memoized verdict for fingerprint-keyed re-judge skipping. */
  last_verdict?: JudgeVerdictMemo | null;
  /** Consecutive HOLDS at the block cap. Once the cap is reached the
   *  preview is held (not committed) every re-run; this counts those holds
   *  so a model that ignores the done-signal and keeps re-running gets a
   *  hard escalation (force the operator choice) instead of looping
   *  forever. Reset to 0 on commit, same as `blocks_since_commit`. */
  holds_at_cap?: number;
}

export interface AuthoringState {
  mode: AuthoringSurfaceMode;
  stage: AuthoringStage;
  connector_mutation_seq: number;
  workflow_mutation_seq: number;
  checkpoints: Partial<Record<AuthoringCheckpointKey, AuthoringCheckpointRecord>>;
  persisted_resources: PersistedResourceRef[];
  latest_execution: LatestExecutionSummary | null;
  latest_diagnosis: LatestDiagnosisSummary | null;
  /** Preview-judge circuit-breaker — see `JudgeBreakerState`. Absent /
   *  null when the judge has never blocked this draft. */
  judge_breaker?: JudgeBreakerState | null;
  /** Fingerprint of the grounding this draft was built on (a hash of the
   *  discovered connector-endpoint projection). `/context` recomputes the
   *  current fingerprint at resume and flags the draft stale when they
   *  differ. Absent / null when no grounded draft was generated. */
  grounding_fingerprint?: string | null;
  /** The connector ids the grounding fingerprint was computed over. Stored
   *  here — not on the workflow draft, whose normalize allowlist would drop
   *  it — so `/context` can re-read the discovery index for exactly those
   *  connectors and recompute the current fingerprint. Absent / null when no
   *  grounded draft was generated. */
  grounding_connector_ids?: string[] | null;
  /** The last authoring intent the user DECLINED, keyed by its intent
   *  fingerprint. An identical re-proposal in the same conversation
   *  references this instead of re-eliciting. Absent / null when nothing
   *  was declined this conversation. */
  last_denied_intent?: { fingerprint: string; timestamp: string } | null;
}

/**
 * The working workflow draft — kept as a plain object so we can evolve
 * the shape freely during a conversation before running the full
 * WorkflowDef validator at commit time.
 */
export interface WorkflowDraftDocument {
  name: string;
  slug?: string;
  description?: string;
  /**
   * The user's goal VERBATIM — stashed by `author_workflow` (pipeline
   * EMIT stage), `build_workflow({ goal })`, and (recipe-derived) by
   * `start_workflow_from_recipe`. Draft-only metadata: it drives the
   * post-preview judge (`preview-judge.ts`) and is intentionally NOT
   * projected into the persisted WorkflowDef
   * (`commit-workflow.ts#workflowDefFromDraft`).
   */
  goal?: string;
  steps: Array<Record<string, unknown>>;
  input_schema?: Record<string, unknown>;
  /**
   * Optional literal example input payload — a concrete value, NOT a JSON
   * Schema (see `WorkflowDef.input_schema_sample`). Read by
   * `resolveWorkflowInputContract` to synthesize a `required`-carrying
   * contract when no explicit `input_schema` is declared, and projected
   * into the persisted WorkflowDef at commit time
   * (`commit-workflow.ts#workflowDefFromDraft`) so the sample-derived tier
   * survives into SAVED workflows. Must survive the `normalizeWorkflowDraft`
   * round-trip or a hydrated draft silently loses it.
   */
  input_schema_sample?: unknown;
  output_schema?: Record<string, unknown>;
  output_transform?: string;
  edges?: Array<{ from: string; to: string }>;
  /** Optional pointer to the skill this draft was authored against
   *  (typically via `start_workflow_from_recipe`). Read by the
   *  workflow validator's skill-schema gate at save time. */
  derived_from_skill_id?: string | null;
  /** Workflow-level trigger. Authored alongside steps via `author_workflow`
   *  and persisted into `WorkflowDef.trigger` at commit time. A schedule
   *  trigger then binds a `workflows_schedules` row via
   *  `applyTriggerBindings` so cron firing is part of the workflow
   *  definition, not a separate `create_schedule` call. */
  trigger?: import("../workflows/types.ts").WorkflowTrigger;
}

export interface ConnectorDraftProbeSummary {
  ok: boolean;
  method: string;
  path: string;
  environment: Environment;
  status_code?: number;
  duration_ms?: number;
  summary: string;
  response_preview?: unknown;
  /** Allowlisted diagnostic response headers from a failed probe (values scrubbed). */
  response_headers?: Record<string, string>;
  failure_code?: string;
  /** sha256 identity of a FAILED probe attempt (draft connection shape +
   *  probe args + credential digest — never the raw secret). The
   *  re-probe guard in `probe_connector_draft` refuses an identical
   *  retry (`probe_unchanged`) until the fingerprint changes, unless
   *  the prior failure was transient (429 / 5xx / timeout). */
  fingerprint?: string;
  /** ISO-8601 timestamp the probe completed at. Used by the
   *  `force_save` cooldown guard in `saveConnectorAtomic`: a probe
   *  that just failed must not be force-saved without first
   *  re-probing with the rotated credential (conversation 730c568a).
   *  Optional for backwards-compat with old persisted drafts. */
  probed_at?: string;
}

export interface ConnectorDraftDocument {
  name?: string;
  slug?: string;
  driver?: DriverName;
  environment?: Environment;
  base_url?: string;
  dsn?: string;
  auth_type?: AuthType;
  config?: Record<string, unknown>;
  description?: string;
  template_slug?: string | null;
  template_name?: string | null;
  template_source?: "builtin" | "tenant" | null;
  docs?: string[];
  validation?: {
    ok: boolean;
    missing_fields: string[];
    errors: Array<{ path: string; message: string }>;
  };
  latest_probe?: ConnectorDraftProbeSummary | null;
  saved_connector_id?: string | null;
}

/**
 * Per-step preview entry persisted on `latest_preview.step_traces`.
 * Built once at the end of every dry_run / run and read by:
 *   - `inspect_workflow_draft` so the LLM can see each step's actual
 *     output shape next to its config (no guessing the JSONata path
 *     of downstream transforms).
 *   - `suggest_jsonata_paths` to enumerate valid `$scope.<id>.<…>`
 *     paths the LLM can copy verbatim.
 *   - `context-assembler.latest_preview` section, surfaced to the
 *     model on every authoring turn.
 *
 * Pre-fix the LLM had to read the entire dry_run envelope every turn
 * to recover any per-step shape it needed. Persisting a compact slot
 * keeps that context warm without burning re-reads.
 */
export interface WorkflowDraftStepPreview {
  step_id: string;
  kind: string;
  status: string;
  /**
   * Step-shape identity at recording time — `<id>#<hash>` from
   * `step-fingerprint.ts#stepFingerprint`. Evidence keyed by this
   * fingerprint survives draft mutations exactly as long as the step's
   * definition is unchanged; any change to the step drops only that
   * step's trace (`pruneTracesForMutation`). The loop/transform
   * authoring gates treat a fingerprint mismatch as missing evidence.
   * Optional only for traces synthesized outside the dry-run path.
   */
  fingerprint?: string;
  duration_ms?: number | null;
  /** Truncated post-selector preview (≤4KB by the offload layer). */
  output_preview?: unknown;
  /**
   * Pre-data_selector envelope (HTTP raw body, GraphQL response,
   * driver result). Lets the LLM see what the selector dropped and
   * choose a different `data_selector` without re-running.
   */
  raw_preview?: unknown;
  /**
   * Authoring-vocab summary of the step's scope: enumerated JSONata
   * paths, one-line shape, and best-guess primary data path.
   * Populated for every step that produced an `output_preview`.
   */
  scope_at_step?: {
    available_paths: string[];
    shape_summary: string;
    primary_data_path: string | null;
  };
  request_meta?: unknown;
  error_code?: string | null;
}

export interface WorkflowDraftPreviewSummary {
  ok: boolean;
  step_id?: string | null;
  summary: string;
  preview?: unknown;
  /**
   * Structured warnings surfaced by the last dry-run (unresolved identifiers,
   * rate-limit hits, pagination edges). Populated by `dry_run_workflow` /
   * `dry_run_step` / `dry_run_transform`. The conversation loop folds these
   * into the next turn's `prior_failures` so the LLM automatically sees what
   * to fix rather than relying on the user to quote them back.
   */
  warnings?: Array<{
    step_key?: string | null;
    code?: string;
    message?: string;
  }>;
  /**
   * Set when the engine flagged the run as needing operator attention
   * (empty extraction over non-empty source, loop body never executed,
   * unresolved_identifier fired). Read by the auto-persist gate to
   * distinguish informational warnings (no `requires_repair`) from
   * real bugs. Mirrors the same flag on `RunResult`.
   */
  requires_repair?: boolean;
  /**
   * Per-step compact preview entries. Indexed by step id. Merged
   * fingerprint-wise on every fresh dry_run / run: steps the new walk
   * touched get their trace replaced; traces for untouched steps
   * survive as long as their `fingerprint` still matches the current
   * draft (`step-fingerprint.ts`). Evidence is therefore dropped per
   * step on definition change, never wholesale.
   */
  step_traces?: WorkflowDraftStepPreview[];
  /**
   * The workflow input passed to the most recent dry_run / run.
   * Surfaced via `inspect_workflow` `payload` section as a fallback
   * when no `input_schema_sample` is set, so the LLM can author
   * against the actual input shape used in the last preview.
   */
  input?: unknown;
}

export interface AuthoringSummary {
  readiness: "drafting" | "needs_input" | "ready_to_probe" | "ready_to_save" | "saved";
  next_action: string | null;
  next_required_action: string | null;
  next_suggested_tool: string | null;
  missing_fields: string[];
  last_action: string | null;
  progress_label: string | null;
  mode: AuthoringSurfaceMode;
  stage: AuthoringStage;
  lifecycle_state: AuthoringLifecycleState;
  active_target: AuthoringActiveTarget;
  blocked_by: string[];
  checkpoints: AuthoringCheckpointView[];
  persisted_resources: PersistedResourceRef[];
  latest_execution: LatestExecutionSummary | null;
  latest_diagnosis: LatestDiagnosisSummary | null;
}

/**
 * Unified authoring-state document. `workflow` is the only supported
 * workflow shape; callers should not rely on mirrored top-level fields.
 */
export interface DraftDocument {
  mode?: AuthoringMode;
  workflow: WorkflowDraftDocument;
  connector?: ConnectorDraftDocument | null;
  summary?: AuthoringSummary;
  latest_preview?: WorkflowDraftPreviewSummary | null;
  state?: AuthoringState;
  session?: {
    permission_mode?: ConversationPermissionMode | null;
    /**
     * Durable playground/sandbox flag. When true this conversation is a
     * scratch authoring surface: the workflow-authoring triad is preloaded
     * so the user can experiment immediately, dry-runs behave normally
     * (hold_writes stays on), but a commit persists NOTHING —
     * `commitWorkflowAtomic` short-circuits with `playground_no_persist`.
     * Set at creation from the `playground` start param / `_meta.sk_playground`
     * and carried across turns by `normalizeDraftDocument`. Never an env flag.
     */
    playground?: boolean | null;
  };
}

/**
 * One frame in the conversation event stream. Emitted by the service
 * loop and consumed by the SSE route and the MCP progress bridge.
 *
 * Mirrors Vercel AI SDK UI's wire model:
 *   - `tool_call_start / tool_call_delta / tool_call_end / tool_result`
 *     carry the `partial-call → call → result` lifecycle keyed by
 *     `call_id`.
 *   - `data_part` is the `data-*` generative-UI channel.
 *   - `elicit_request` represents an `askUser.*` pause; the client
 *     renders a component based on `tool_name` and posts the answer
 *     to `POST /v1/conversations/:id/elicitations/:eid/respond`.
 */
/**
 * Optional anchor field carried on every child event (`tool_call_*`,
 * `tool_result`, `tool_log`, `elicit_request`) — references the
 * assistant message ID this child belongs to. Live emissions populate
 * it after the assistant message is inserted; replay populates it from
 * the persisted `parent_message_id` column. Clients use it to render
 * children inline under the right message row in the timeline.
 */
export type TurnEvent =
  | {
      type: "message";
      role: ConversationRole;
      content: unknown;
      /** Persisted message ID (assistant rows only — newly added). */
      id?: string;
      /** Self-anchor for symmetry with child events. */
      parent_message_id?: string;
    }
  /**
   * Incremental assistant-text delta. Emitted as `streamText` produces
   * tokens. Clients (sk Ink, HTTP SSE, MCP) should concatenate `text`
   * for live rendering; the final `message` event carries the full
   * assistant turn text for persisted replay.
   */
  | { type: "text_delta"; text: string }
  /**
   * Per-tool progress log. Emitted during long-running tool execution
   * (run_workflow, dry_run_step, etc.) so the user sees incremental
   * state rather than waiting for the tool to finish silently.
   */
  | {
      type: "tool_log";
      call_id: string;
      tool: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      ts: string;
      parent_message_id?: string;
    }
  | {
      type: "tool_call_start";
      call_id: string;
      tool: string;
      input_partial?: unknown;
      parent_message_id?: string;
    }
  | {
      type: "tool_call_delta";
      call_id: string;
      input_patch: unknown;
      parent_message_id?: string;
    }
  | {
      type: "tool_call_end";
      call_id: string;
      input: unknown;
      parent_message_id?: string;
    }
  | {
      type: "tool_result";
      call_id: string;
      tool: string;
      output: unknown;
      parent_message_id?: string;
    }
  | { type: "data_part"; data_type: string; payload: unknown }
  | { type: "validation_error"; errors: Array<{ path: string; message: string }> }
  | {
      type: "elicit_request";
      elicitation_id: string;
      /**
       * The `conversation_tool_calls` row id of the originating tool
       * call (the gated tool, OR the ask_user_* tool the LLM emitted
       * directly). Clients can correlate the elicitation to "the call
       * that paused" without a follow-up DB read, and may resume by
       * either id (engine accepts both as aliases).
       */
      tool_call_id?: string;
      /** Which `askUser.*` tool paused the loop. */
      tool_name: string;
      /** Short summary stored on the elicitation row (audit + list view). */
      summary: string;
      /**
       * Full tool input payload — options list, form fields, question
       * text, confirm diff/target, etc. Clients dispatch on
       * `tool_name` and read this record to render the right prompt.
       */
      input: unknown;
      /**
       * Structured "what will happen" preview produced by the gated
       * tool's `buildPendingOutput` hook. When set, the client renders
       * its key fields (target id, environment, diff summary) inside
       * the confirmation card instead of guessing from raw input.
       */
      pending_output?: Record<string, unknown> | null;
      parent_message_id?: string;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: ConversationStatus; usage?: TurnUsage }
  /**
   * Inline unified-diff cell. Emitted after a draft-mutation tool
   * produces a meaningful structural change (workflow build, patch,
   * connector update). The CLI renders a colored gutter + content
   * diff — operators see exactly what changed without scrolling back
   * to the prior state.
   *
   * The engine pre-computes line-by-line hunks (no diff library on
   * the CLI side). `language` lets the renderer pick a syntax theme
   * but otherwise the strings are rendered verbatim.
   */
  | {
      type: "diff";
      title: string;
      language: "json" | "yaml" | "text";
      hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
      /** Optional anchor — same as tool_call's `parent_message_id`
       *  pattern so the cell threads under the right assistant turn. */
      parent_message_id?: string;
    }
  /**
   * Single-line activity ticker the CLI renders between the transcript
   * and the spinner. Tells the operator WHAT the engine is doing right
   * now in human-readable form — `"calling probe_connector"`,
   * `"composing reply"`, `"idle · last: delete_workflow ok 142ms"`.
   *
   * Emitted at meaningful phase boundaries only:
   *   - `phase: "tool"`   — a tool just started; `label` = tool name.
   *   - `phase: "composing"` — LLM provider is streaming text.
   *   - `phase: "idle"`   — between tool calls / between turn-bursts;
   *                         `last_completed` carries the previous tool's
   *                         summary for the operator to reason about.
   *
   * Engine-side throttled in EventSink (200ms window, same `(phase,
   * label)` collapsed) so a tool burst never floods the wire. CLI also
   * debounces the payload at 250ms before re-rendering, so even the
   * smallest legitimate burst paints exactly once.
   *
   * Never persisted, never folded into transcript cells. Pure UI hint.
   */
  | {
      type: "activity";
      phase: "tool" | "composing" | "idle";
      /** Free-form one-line label rendered to the right of the spinner.
       *  Prefer visibility over silence — when in doubt emit a generic
       *  "Working" label rather than nothing. */
      label: string;
      /** Optional tool name when phase is `"tool"` (call card already
       *  surfaced separately; this just lets the ticker stay accurate
       *  if the call card is scrolled out of view). */
      tool_name?: string;
      /** Optional call id, useful for cross-correlating with the
       *  ToolCallState card the user can scroll back to. */
      call_id?: string;
      /** Set on `phase: "idle"` after a tool just finished. The CLI
       *  shows it as `last: <tool> ok|fail · <duration>ms` so the
       *  operator can see what the engine just did even if it scrolled
       *  past. */
      last_completed?: {
        tool_name: string;
        ok: boolean;
        duration_ms: number;
      };
    }
  /**
   * Next-message preview frame. Emitted exactly once per turn, after
   * the assistant's terminal `message` and before the SSE `outcome` /
   * `done` envelope. Carries either a non-null suggestion the client
   * paints as ghost text in the input composer, or `null` with a
   * `reason` tag explaining why no suggestion was produced (the
   * client just silently skips render in that case).
   *
   * `kind: "text"` → user accepts and the suggestion is inserted as
   * literal input. `kind: "slash"` → user accepts and the slash
   * dispatcher routes the command directly. `null` kind always pairs
   * with a null suggestion.
   */
  | {
      type: "next_suggestion";
      suggestion: string | null;
      reason: SuggestNextReason;
      kind: SuggestNextKind | null;
    }
  /**
   * Terminal citations frame — the "prove-after" grounding half made
   * visible. Emitted exactly once per turn AFTER the assistant's terminal
   * `message`, and before the `next_suggestion` / `completed` frames and the
   * SSE `outcome` envelope (which drops `events[]`), only when the turn
   * produced citations that resolve to a real source. The client anchors the
   * footer by `parent_message_id`, so this wire order is not load-bearing.
   * Carries the same refs already harvested for the audit log; the client
   * renders a dim "Sources: …" footer under the anchored assistant message.
   * Absent entirely on citation-less turns.
   */
  | {
      type: "citations";
      citations: Citation[];
      /** Assistant message the footer anchors under; falls back to the
       *  last assistant message client-side when unset. */
      parent_message_id?: string;
    };

export interface ConversationResumeSummary {
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    slug: string | null;
    id: string | null;
    environment: string | null;
  };
  stage: string;
  last_successful_probe: string | null;
  last_successful_preview: string | null;
  unsaved: boolean;
  pending_approval: {
    id: string;
    tool_name: string;
    summary: string;
  } | null;
  next_action: string;
  one_sentence: string;
}

export interface ConversationDetail {
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
  tool_calls: ConversationToolCallRecord[];
  draft: DraftDocument | null;
  /**
   * Surfaced when reattaching carries forward prior authoring work — a
   * one-sentence "where were we / what next" banner plus structured
   * state. Null when this is a fresh or already-committed conversation.
   */
  resume_summary?: ConversationResumeSummary | null;
}

/**
 * Parts-based message shape, mirroring Vercel AI SDK UI's `UIMessage`.
 * The engine persists `ConversationMessageRecord.content` as JSONB;
 * the `toMessageParts` adapter in `parts.ts` reconstructs a
 * `UIMessage` for the detail endpoint. Tool calls, tool results,
 * reasoning blocks, and `data_part` payloads all render through
 * per-part components instead of a single opaque blob.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      call_id: string;
      tool: string;
      input: unknown;
      phase: "partial" | "called" | "result";
    }
  | { type: "tool_result"; call_id: string; tool: string; output: unknown }
  | { type: "data"; data_type: string; payload: unknown };

export interface UIMessage {
  id: string;
  role: ConversationRole;
  parts: ContentPart[];
  created_at: string;
}

// Re-export for callers.
export type { WorkflowDef };
