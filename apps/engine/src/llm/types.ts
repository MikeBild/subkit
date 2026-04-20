// Shared LLM types. Kept in one file so every flow and the context
// pipeline pull from the same shapes.

import type { FilePart, ImagePart, TextPart } from "ai";
import type { Skill } from "../skills/types.ts";
import type { ProviderKind } from "./core/model-init.ts";

export type LlmFlow = "generate" | "extract" | "repair" | "converse" | "discover" | "summarize";

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
}

/** Knowledge Source chunk included in the prompt. */
export interface IncludedKnowledgeChunk {
  id: string;
  knowledge_source_id: string;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
  tokens: number;
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
   * Skill ids (or titles) the caller has explicitly loaded for this
   * conversation via `load_skill`. Their full body is injected into
   * the stable cache block on every turn — in addition to the
   * scope-based `retrieveApplicableSkills` result — so on-demand
   * domain knowledge actually reaches the model.
   */
  loaded_skill_slugs?: string[];
  /**
   * Pre-rendered authoring context block — a structured "current state"
   * summary describing the active draft, readiness, missing fields,
   * latest probe/preview, pending approval, and resume banner. Emitted
   * into the volatile cache segment on every turn so the model can
   * reason about progress without replaying prior tool results. Secrets
   * must be masked before this string reaches the assembler.
   */
  authoring_context?: string;
}

/** Result of Context Enhancement — ready for an SDK call. */
export interface EnhancedPrompt {
  system: string;
  messages: UserTurn[];
  token_counts: {
    system: number;
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
    messages: number;
    total: number;
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
}
