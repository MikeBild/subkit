// Shared LLM types. Kept in one file so every flow and the context
// pipeline pull from the same shapes.

import type { FilePart, ImagePart, TextPart } from "ai";

import type {
  AuthoringActiveTarget,
  AuthoringCheckpointView,
  AuthoringLifecycleState,
  AuthoringStage,
  AuthoringSurfaceMode,
} from "../conversations/types.ts";
import type { Skill } from "../skills/types.ts";
import type { ProviderKind } from "./core/model-init.ts";

export type LlmFlow =
  | "generate"
  | "extract"
  | "repair"
  /**
   * The in-band retry after a model emits a tool call whose arguments fail
   * validation. Its own flow and not folded into `repair`, which is the
   * self-healing patch proposal — two different mechanisms, two different
   * cost profiles, and one name over both would make either unreadable.
   *
   * Small by design: capped at two per turn, because a model that keeps
   * emitting malformed calls is in a degenerate state and buying more repairs
   * does not help. It went unrecorded until 2026-08-19 all the same.
   */
  | "tool_repair"
  | "converse"
  | "discover"
  | "summarize"
  | "suggest_next"
  | "critic_authoring"
  | "judge"
  /**
   * An LLM call made by a workflow `request` step through an ordinary HTTP
   * connector. Distinct from the flows above: the engine did not choose the
   * model or build the prompt, it only carried the call — but it is the same
   * money, and leaving it out is why the editorial pipeline reported zero.
   */
  | "workflow_step";

export type LlmProviderKind = ProviderKind;

/** Resolved per-call routing decision. */
export interface ModelRoute {
  tenant_id: string;
  primary: string;
  fallback: string;
  provider: LlmProviderKind;
  fallback_provider: LlmProviderKind;
  /** Effective context-length cap for the primary model (tokens). */
  context_cap: number;
  /** Monthly budget for the tenant; null = unlimited. */
  monthly_budget: number | null;
  /**
   * Per-tenant toggle for Anthropic ephemeral prompt caching. When set
   * the provider attaches `providerOptions.anthropic.cacheControl` to
   * the system prompt so stable heads (skills, docs) are re-billed at
   * ~10 % of their input-token cost. Default false at rollout.
   */
  enable_prompt_cache: boolean;
}

/** User turn in the prompt — kept intentionally narrow. */
export interface UserTurn {
  role: "user" | "assistant" | "system";
  content: string;
  /** Multimodal parts; when present, takes precedence over `content`. */
  content_parts?: Array<TextPart | ImagePart | FilePart>;
}

/** One failing-step trace fed into `repair`. */
export interface PriorFailure {
  step_id: string;
  error: string;
  captured_response?: string;
  schema_diff?: string;
}

/** Ingested connector documentation chunk included in the prompt. */
export interface IncludedChunk {
  id: string;
  document_id: string;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
  tokens: number;
  /** ISO-8601 of the source document's last fetch. Used to surface staleness. */
  fetched_at: string | null;
}

/** Knowledge Source chunk included in the prompt. */
export interface IncludedKnowledgeChunk {
  id: string;
  knowledge_source_id: string;
  source_name: string;
  source_tags: string[];
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
  /**
   * Optional sub-mode hint orthogonal to the primary mode.
   * Currently used to switch the persona to the RBAC-editing variant
   * when the operator is configuring a role's policy.
   */
  scope?: "rbac";
}

export interface AssembleContextParams {
  tenant_id: string;
  flow: LlmFlow;
  connector_id?: string;
  workflow_id?: string;
  user_turns: UserTurn[];
  prior_failures?: PriorFailure[];
  /** Hard cap on the assembled prompt in tokens. */
  max_tokens: number;
  /** Effective model id — used to look up the tokenizer encoding. */
  model?: string;
  /**
   * Free-form user memory content sourced from the caller-supplied
   * SUBKIT.md / CLAUDE-Code-style memory file. Slotted into the
   * assembled prompt under a dedicated "User memory" section between
   * workflow skills and ingested connector docs. Trimmed before
   * Skills but after docs / history on overflow.
   */
  user_memory?: string;
  /**
   * Recency-current full-body subset — the slugs whose FULL body is
   * rendered this turn (loaded AND within the K-turn recency window).
   * Their body is injected into the stable cache block in addition to
   * the scope-based `retrieveApplicableSkills` result. Slugs that have
   * aged out of the window are NOT here — they fall back to the "Loaded"
   * index via `loaded_skill_membership`.
   */
  loaded_skill_slugs?: string[];
  /**
   * ALL loaded slugs regardless of recency (membership). Drives the
   * index-safety "Loaded" index block: any membership slug not already
   * rendered as a full body and not present in the scope-based index is
   * rendered as a one-line index entry so an ever-loaded skill (a
   * demoted connector/workflow-scoped-out-of-scope or experimental skill)
   * never disappears. A single `load_skill` call re-fetches the full body.
   */
  loaded_skill_membership?: string[];
  /**
   * Pre-rendered authoring context block — a structured "current state"
   * summary describing the active draft, readiness, missing fields,
   * latest probe/preview, pending approval, and resume banner. Emitted
   * into the volatile cache segment on every turn so the model can
   * reason about progress without replaying prior tool results. Secrets
   * must be masked before this string reaches the assembler.
   */
  authoring_context?: string;
  /**
   * Objects the user @-mentioned on this turn, already resolved by
   * `conversations/references.ts`. `block` is the full rendering; the
   * budget trimmer swaps in `trim_ref` (one line per object) instead of
   * dropping the section — the user pointed at these on purpose.
   */
  referenced_entities?: { block: string; trim_ref: string };
  /**
   * Small machine-readable authoring snapshot used to pick the
   * mode/stage-specific converse focus block.
   */
  authoring_hint?: AuthoringPromptHint;
  /**
   * Connector ids bound to the active conversation/draft — the target
   * connector, the persisted draft connector, and every connector a
   * draft workflow step references. Drives the "Recorded endpoint
   * samples" section in workflow-authoring mode: the latest recorded
   * response shapes for exactly these connectors reach the model
   * BEFORE it writes request paths and transforms.
   */
  authoring_connector_ids?: string[];
  /**
   * Conversation id, when the assembler is being driven from the
   * converse flow. When present, the assembler loads the last N
   * resolved elicitations (`conversation_elicitations` rows) and
   * renders them as an `interaction_log` section so the model can see
   * what was tested vs. confirmed vs. declined this turn. Without it the
   * model re-asks for already-declined actions and double-acts on already-
   * confirmed ones.
   */
  conversation_id?: string;
  /**
   * Real runtime context the model must quote verbatim instead of
   * inventing placeholders. Rendered into a stable block placed right
   * after the base system prompt. See `llm/runtime-context.ts`.
   */
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
    surface?: string;
  };
}

/** Result of Context Enhancement — ready for an SDK call. */
export interface EnhancedPrompt {
  system: string;
  /**
   * `system`, still split into the sections the assembler built it from, each
   * flagged with whether it survives a turn.
   *
   * The splitter used to re-derive this by cutting `system` on blank lines and
   * matching two known headers, which mis-classified everything it did not
   * recognise as stable AND cut multi-paragraph sections in half. The assembler
   * knows the answer already; this carries it rather than guessing it back.
   */
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
    /**
     * Tokens spent on the recipe-bodies section (rendered hybrid payload
     * for top-K connector recipes). Bounded by the assembler's intra-
     * section pre-trim cap.
     */
    recipe_bodies: number;
    /**
     * Tokens spent on the skill-candidates section (proposed candidates
     * surfaced for authoring). Bounded by the same intra-section trim.
     */
    skill_candidates: number;
    /**
     * Tokens spent on the Prior-Workflows section (top-K active workflow
     * reference cases for the in-flight authoring intent). Bounded by
     * `PRIOR_WORKFLOWS_SECTION_CAP`. Always 0 in the converse flow,
     * which fetches workflows on demand via the tenant snapshot + tools.
     */
    prior_workflows: number;
    /** Tokens spent on the `[REFERENCED ENTITIES]` block (user @-mentions). */
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
  /**
   * Tokens served from Anthropic's ephemeral prompt cache. Counted as
   * part of `prompt_tokens` by Anthropic's usage object; subtracted and
   * re-added at `CACHE_READ_WEIGHT` in `total_tokens` for budget math.
   */
  cache_read_tokens?: number;
  /**
   * Tokens written into Anthropic's ephemeral prompt cache this call.
   * Counted as part of `prompt_tokens`; re-added at `CACHE_CREATE_WEIGHT`.
   */
  cache_creation_tokens?: number;
  latency_ms: number;
  result: "success" | "quota_exhausted" | "context_too_large" | "error";
  error?: string;
  execution_id?: string;
  conversation_id?: string;
  /** The acting end-user, if any. Null for system / system_account flows. */
  user_id?: string | null;
  /** Attribution class for this call; defaults to "system" when omitted. */
  actor_type?: "user" | "system_account" | "system";
}
