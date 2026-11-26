import type { FilePart, ImagePart, TextPart } from "ai";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type {
  AuthoringActiveTarget,
  AuthoringCheckpointView,
  AuthoringLifecycleState,
  AuthoringStage,
  AuthoringSurfaceMode,
} from "../conversations/types.ts";
import type { Skill } from "../skills/types.ts";
import type { ProviderKind } from "./runtime/model-init.ts";

export type LlmFlow =
  | "generate"
  | "extract"
  | "catalog_describe"
  | "repair"
  | "tool_repair"
  | "converse"
  | "discover"
  | "summarize"
  | "suggest_next"
  | "critic_authoring"
  | "judge"
  | "workflow_step"
  | "personal_notes"
  | "transcription";

export type LlmProviderKind = ProviderKind;

export interface ModelRoute {
  tenant_id: string;
  primary: string;
  fallback: string;
  provider: LlmProviderKind;
  fallback_provider: LlmProviderKind;
  context_cap: number;
}

export interface UserTurn {
  role: "user" | "assistant" | "system";
  content: string;
  content_parts?: Array<TextPart | ImagePart | FilePart>;
}

export interface PriorFailure {
  step_id: string;
  error: string;
  captured_response?: string;
  schema_diff?: string;
}

export interface IncludedChunk {
  id: string;
  document_id: string;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
  tokens: number;
  fetched_at: string | null;
}

export interface IncludedKnowledgeChunk {
  id: string;
  knowledge_source_id: string;
  source_name: string;
  source_tags: string[];
  source_description: string | null;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
  tokens: number;
  fetched_at: string | null;
}

export interface AuthoringPromptHint {
  mode: AuthoringSurfaceMode;
  stage: AuthoringStage;
  lifecycle_state: AuthoringLifecycleState;
  active_target: Pick<AuthoringActiveTarget, "kind" | "lifecycle_state">;
  blocked_by: string[];
  next_required_action: string | null;
  next_suggested_tool: string | null;
  checkpoints: AuthoringCheckpointView[];
  latest_execution: {
    diagnosis_available: boolean;
  } | null;
  latest_diagnosis: {
    reason: string;
  } | null;
  scope?: "rbac";
  ask_before_writing?: boolean;
  locked_tools?: ReadonlyArray<{ skill: string; tools: readonly string[] }>;
}

export interface AssembleContextParams {
  tenant_id: string;
  flow: LlmFlow;
  connector_id?: string;
  connector_ids?: string[];
  domains?: string[];
  workflow_id?: string;
  user_turns: UserTurn[];
  retrieval_query?: string;
  prior_failures?: PriorFailure[];
  max_tokens: number;
  model?: string;
  user_memory?: string;
  loaded_skill_slugs?: string[];
  loaded_skill_membership?: string[];
  guidance_skill_slugs?: string[];
  authoring_context?: string;
  automation_context?: string;
  referenced_entities?: { block: string; trim_ref: string };
  authoring_hint?: AuthoringPromptHint;
  authoring_connector_ids?: string[];
  conversation_id?: string;
  principal?: ResolvedPrincipal;
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
    surface?: string;
  };
}

export interface EnhancedPrompt {
  system: string;
  system_sections?: Array<{ text: string; volatile: boolean }>;
  messages: UserTurn[];
  token_counts: {
    system: number;
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
    messages: number;
    total: number;
    recipe_bodies: number;
    conventions: number;
    prior_workflows: number;
    references: number;
  };
  included_skill_ids: string[];
  included_chunk_ids: string[];
  included_knowledge_chunk_ids: string[];
  included_skills: Skill[];
  included_chunks: IncludedChunk[];
  included_knowledge_chunks: IncludedKnowledgeChunk[];
}

export interface LlmCallLogEntry {
  tenant_id: string;
  flow: LlmFlow;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_reported?: boolean;
  latency_ms: number;
  result: "success" | "quota_exhausted" | "context_too_large" | "key_rejected" | "error";
  error?: string;
  execution_id?: string;
  conversation_id?: string;
  user_id?: string | null;
  actor_type?: "user" | "system_account" | "system";
}
