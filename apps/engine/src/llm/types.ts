// Shared LLM types. Kept in one file so every flow and the context
// pipeline pull from the same shapes.

import type { Skill } from "../skills/types.ts";

export type LlmFlow = "generate" | "extract" | "repair" | "converse" | "discover";

export type LlmProviderKind = "anthropic" | "openai" | "bedrock" | "vertex" | "azure" | "mock";

/** Resolved per-call routing decision. */
export interface ModelRoute {
  tenant_id: string;
  primary: string;
  fallback: string;
  provider: LlmProviderKind;
  /** Effective context-length cap for the primary model (tokens). */
  context_cap: number;
  /** Monthly budget for the tenant; null = unlimited. */
  monthly_budget: number | null;
}

/** User turn in the prompt — kept intentionally narrow. */
export interface UserTurn {
  role: "user" | "assistant" | "system";
  content: string;
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
  latency_ms: number;
  result: "success" | "quota_exhausted" | "context_too_large" | "error";
  error?: string;
}
