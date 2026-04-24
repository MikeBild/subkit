// Conversation types shared across the service, loop, tool palette,
// and HTTP / MCP layers.

import type { AuthType, DriverName, Environment } from "../connectors/types.ts";
import type { WorkflowDef } from "../workflows/types.ts";

export type ConversationStatus = "active" | "awaiting_input" | "committed" | "abandoned";
export type ConversationPermissionMode = "auto" | "ask" | "plan";

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
   * Remaining token budget for the tenant's current month, or null
   * when the tenant is unlimited.
   */
  remaining_monthly_budget_tokens: number | null;
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
   * call. Nullable for legacy rows; the read path falls back to a
   * time-window join when null.
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
  status: string;
  environment: Environment;
  warnings_count: number;
  recorded_at: string;
  diagnosis_available: boolean;
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

export interface AuthoringState {
  mode: AuthoringSurfaceMode;
  stage: AuthoringStage;
  connector_mutation_seq: number;
  workflow_mutation_seq: number;
  checkpoints: Partial<Record<AuthoringCheckpointKey, AuthoringCheckpointRecord>>;
  persisted_resources: PersistedResourceRef[];
  latest_execution: LatestExecutionSummary | null;
  latest_diagnosis: LatestDiagnosisSummary | null;
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
  steps: Array<Record<string, unknown>>;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  output_transform?: string;
  edges?: Array<{ from: string; to: string }>;
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
  failure_code?: string;
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
  template_id?: string | null;
  template_name?: string | null;
  docs?: string[];
  validation?: {
    ok: boolean;
    missing_fields: string[];
    errors: Array<{ path: string; message: string }>;
  };
  latest_probe?: ConnectorDraftProbeSummary | null;
  saved_connector_id?: string | null;
}

export interface WorkflowDraftPreviewSummary {
  ok: boolean;
  step_id?: string | null;
  summary: string;
  preview?: unknown;
}

export interface AuthoringSummary {
  readiness: "drafting" | "needs_input" | "ready_to_probe" | "ready_to_save" | "saved";
  next_action: string | null;
  next_required_action: string | null;
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
      parent_message_id?: string;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: ConversationStatus; usage?: TurnUsage };

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
