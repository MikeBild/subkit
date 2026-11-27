import type { LocalConfirmation } from "@shared/device/confirmation.ts";
import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import type { AuthType, DriverName, Environment } from "../connectors/types.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import type { Citation } from "./citations.ts";
import type { ToolCallPolicyView } from "./instruction-cover/view.ts";
import type { ConversationReference } from "./references.ts";
import type { ConnectorCallSubject, ExternalToolSubject } from "./resume.ts";
import type { ResumeFormField } from "./resume-form.ts";
import type { ToolCallOutcome } from "./tools/result-payload.ts";

export type ConversationStatus = "active" | "awaiting_input" | "committed" | "abandoned";

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
  title_locked: boolean;
  origin_client: string | null;
  surface: string | null;
  visibility: "private" | "team";
  created_at: string;
  updated_at: string;
}

export interface ConversationOwner {
  id: string;
  kind: "user" | "system_account";
  name: string;
}

export interface ConversationTargetRef {
  id: string;
  slug: string | null;
  name: string | null;
}

export interface ConversationCreatedResource {
  kind: "workflow" | "connector" | "execution";
  id: string;
  slug: string | null;
  name: string | null;
  at: string;
}

export interface TurnUsage {
  turn_tokens?: number;
  prompt_tokens_last_call?: number;
  turn_tokens_total?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_reported?: boolean;
  cache_read_pct?: number;
  context_cap_tokens?: number;
  spend_notice?: {
    run: "chat_turn" | "task_run";
    run_cost_usd: number;
    threshold_usd: number;
    currency: string;
  };
  breakdown?: {
    system: number;
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
    messages: number;
    recipe_bodies: number;
    conventions: number;
    total: number;
  };
}

export interface ConversationMessageRecord {
  id: string;
  conversation_id: string;
  role: ConversationRole;
  content: unknown;
  model: string | null;
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
  parent_message_id?: string | null;
  confirmation_state: string | null;
  approved_at: string | null;
  outcome: ToolCallOutcome | null;
  policy?: ToolCallPolicyView | null;
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
  redacted?: boolean;
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
  draft_version_id?: string | null;
  current_version_id?: string | null;
  persistence_kind?: "draft" | "active";
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
  credential_snapshots?: import("../credentials/index.ts").CredentialUseSnapshot[];
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

export interface JudgeVerdictMemo {
  fingerprint: string;
  verdict: "passes" | "partial" | "failed";
  reason: string;
  missing: string[];
}

export interface JudgeBreakerState {
  blocks_since_commit: number;
  last_verdict?: JudgeVerdictMemo | null;
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
  judge_breaker?: JudgeBreakerState | null;
  grounding_fingerprint?: string | null;
  grounding_connector_ids?: string[] | null;
  last_denied_intent?: { fingerprint: string; timestamp: string } | null;
  authoring_focus?: "connector" | null;
  latest_workflow_save_error?: {
    code: "draft_conflict";
    message: string;
    mutation_seq: number;
  } | null;
}

export interface WorkflowDraftDocument {
  service_package_source?: {
    package_id: string;
    package_version: string;
    connector_id: string;
    workflow_slug: string;
    prefix: string;
    artifact_hash: string;
    definition_hash: string;
  };
  execution_privacy?: WorkflowDef["execution_privacy"];
  name: string;
  slug?: string;
  description?: string;
  goal?: string;
  spec?: import("../workflows/draft-schemas.ts").WorkflowSpec;
  steps: Array<Record<string, unknown>>;
  input_schema?: Record<string, unknown>;
  input_schema_sample?: unknown;
  output_schema?: Record<string, unknown>;
  validation_expression?: string;
  validation_function?: string;
  output_transform?: string;
  output_transform_function?: string;
  response_filters?: WorkflowDef["response_filters"];
  timeout_ms?: number;
  max_llm_tokens_per_run?: number;
  runtime?: WorkflowDef["runtime"];
  edges?: Array<{ from: string; to: string }>;
  derived_from_skill_id?: string | null;
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
  response_headers?: Record<string, string>;
  failure_code?: string;
  fingerprint?: string;
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

export interface WorkflowDraftStepPreview {
  step_id: string;
  kind: string;
  status: string;
  fingerprint?: string;
  duration_ms?: number | null;
  output_preview?: unknown;
  raw_preview?: unknown;
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
  warnings?: Array<{
    step_key?: string | null;
    code?: string;
    message?: string;
  }>;
  requires_repair?: boolean;
  step_traces?: WorkflowDraftStepPreview[];
  input?: unknown;
  redacted?: boolean;
  mode?: "schema_only";
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

export interface TaskRunMarker {
  task_id: string;
  task_run_id: string;
  environment: "dev" | "prod";
  workflow_ids: string[];
  connector_ids: string[];
  web_search: boolean;
  sealed?: true;
}

export interface TaskRunCheck {
  at: string;
  reason: string;
}

export interface DraftDocument {
  mode?: AuthoringMode;
  workflow: WorkflowDraftDocument;
  connector?: ConnectorDraftDocument | null;
  summary?: AuthoringSummary;
  latest_preview?: WorkflowDraftPreviewSummary | null;
  state?: AuthoringState;
  session?: {
    playground?: boolean | null;
    intake_item_ids?: string[] | null;
    intake_read_item_versions?: Record<string, number> | null;
    intake_review_locked?: boolean | null;
    intake_review_active?: boolean | null;
    live_test?: {
      workflow_id: string;
      workflow_version_id: string;
      environment: "dev";
      input: unknown;
      input_digest: string;
      idempotency_key: string;
      state: "pending" | "running" | "succeeded" | "failed" | "blocked";
      execution_id?: string | null;
    } | null;
    task_run?: TaskRunMarker | null;
    task_check?: TaskRunCheck | null;
  };
}

export type TurnEvent =
  | {
      type: "message";
      role: ConversationRole;
      content: unknown;
      id?: string;
      parent_message_id?: string;
      origin?: "task_run_continuation";
    }
  | { type: "text_delta"; text: string }
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
      tool_call_id?: string;
      tool_name: string;
      summary: string;
      input: unknown;
      pending_output?: Record<string, unknown> | null;
      parent_message_id?: string;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: ConversationStatus; usage?: TurnUsage }
  | {
      type: "diff";
      title: string;
      language: "json" | "yaml" | "text";
      hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
      parent_message_id?: string;
    }
  | {
      type: "activity";
      phase: "tool" | "composing" | "idle";
      label: string;
      retry?: { attempt: number; of: number };
      tool_name?: string;
      call_id?: string;
      last_completed?: {
        tool_name: string;
        ok: boolean;
        duration_ms: number;
      };
    }
  | {
      type: "next_suggestion";
      suggestion: string | null;
      reason: SuggestNextReason;
      kind: SuggestNextKind | null;
    }
  | {
      type: "citations";
      citations: Citation[];
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
  focused_run: {
    execution_id: string;
    status: string;
    recorded_at: string;
  } | null;
  live_test: {
    execution_id: string;
    status: string;
  } | null;
  last_successful_probe: string | null;
  last_successful_preview: string | null;
  unsaved: boolean;
  pending_approval: {
    id: string;
    tool_call_id?: string | null;
    tool_name: string;
    prompt?: {
      question: string;
      intent_kind?: string;
      approval_backed?: boolean;
      kind?: string;
      diffs?: { label: string; preview?: string }[];
      authorization_url?: string;
      fields?: ResumeFormField[];
      external_tool?: ExternalToolSubject;
      effect?: ConnectorCallSubject;
      subjects?: string[];
      device?: LocalConfirmation;
      payment_id?: string;
    };
    summary: string;
    expires_at: string;
  } | null;
  next_action: string;
  one_sentence: string;
}

export interface ConversationDetail {
  playbook?: import("./playbook-contract.ts").PlaybookView | null;
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
  tool_calls: ConversationToolCallRecord[];
  draft: DraftDocument | null;
  owner: ConversationOwner | null;
  created_resources: ConversationCreatedResource[];
  resume_summary?: ConversationResumeSummary | null;
}

export type ContentPart =
  | {
      type: "text";
      text: string;
      references?: ConversationReference[];
      unresolved_references?: ConversationReference[];
      decision?: { state: string; tool: string | null };
    }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      call_id: string;
      tool: string;
      input: unknown;
      phase: "partial" | "called" | "result";
    }
  | {
      type: "tool_result";
      call_id: string;
      tool: string;
      output: unknown;
      outcome: ToolCallOutcome | null;
      confirmation_state?: string | null;
    }
  | { type: "data"; data_type: string; payload: unknown };

export interface UIMessage {
  id: string;
  role: ConversationRole;
  parts: ContentPart[];
  model: string | null;
  created_at: string;
  origin?: "task_run_continuation";
  citations?: Citation[];
}

export type { GateOutcome, GateRecord } from "./confirmation.ts";
export {
  ConversationNotFoundError,
  ConversationTurnInProgressError,
  ElicitationActorMismatchError,
  ElicitationAlreadyResolvedError,
  ElicitationAnswerActorUnavailableError,
  ElicitationNotFoundError,
  ElicitationValidationError,
  PendingElicitationBlockedError,
} from "./errors.ts";
export type { ConversationSurface } from "./lifecycle-view.ts";
export type { RunLoopResult } from "./loop/types.ts";
export type { TimeoutPhase } from "./turn-failure.ts";
export type { WorkflowDef };
