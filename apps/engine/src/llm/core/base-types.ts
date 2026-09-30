// Base LLM abstraction types for the subkit engine — tenant + flow +
// telemetry metadata woven into the core AI SDK call shapes.
//
// Every LLM call in the engine funnels through `core/invoke.ts`, which
// builds one of these request shapes and invokes the AiSdkModel. Only the
// `ai` package (Vercel AI SDK v6) is imported here — no provider packages.

import type { FilePart, ImagePart, TextPart, Tool } from "ai";
import type { LlmFlow } from "../types.ts";

export interface SubkitLlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<TextPart | ImagePart | FilePart>;
  /**
   * Provider-specific per-message options, passed through to the SDK verbatim.
   *
   * This carries the prompt-cache hint. Without a slot for it the hint was
   * built by `toSystemMessages` and then dropped on the way to the provider —
   * `enable_prompt_cache` gated a value nothing could ever read, so every
   * one-shot flow paid full price for a prefix it re-sent every call.
   */
  // Structural rather than imported: the SDK declares ProviderOptions but does
  // not export it, and `messages` is cast to ModelMessage[] at the call site
  // anyway (ai-sdk-model.ts), so this only has to describe the shape.
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Which model produced the answer. A refused primary is retried on the
 * fallback inside the model call, so the model that was asked and the model
 * that answered can differ — and the usage belongs to the one that answered.
 */
export interface SubkitLlmAnsweredBy {
  model_used: string;
  fell_back: boolean;
  /** The primary's refusal that moved the call to the fallback. */
  primary_error?: string;
}

export interface SubkitLlmResponse extends SubkitLlmAnsweredBy {
  response: string;
  messages: SubkitLlmMessage[];
  usage: SubkitLlmUsage;
  finish_reason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";
}

export interface SubkitLlmObjectResponse<T> extends SubkitLlmAnsweredBy {
  success: boolean;
  response: T | string;
  messages: SubkitLlmMessage[];
  usage: SubkitLlmUsage;
}

export interface SubkitLlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface SubkitLlmToolDefinition {
  name: string;
  description: string;
  arguments: Record<string, unknown>;
  execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
}

export interface SubkitLlmToolWithContext {
  toolDefinition: SubkitLlmToolDefinition | Record<string, Tool>;
  toolContext?: unknown;
  maxUses?: number;
}

export interface SubkitLlmObjectGeneratorInput {
  messages: SubkitLlmMessage[];
  schema: Record<string, unknown>;
  temperature?: number;
  tools?: SubkitLlmToolWithContext[];
  toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
  metadata?: Record<string, unknown>;
  /**
   * Hard cap on the submit/abort tool-use loop inside `generateObject()`.
   * Defaults to `MAX_TOOL_LOOP_ATTEMPTS` (8). Callers can lower it for
   * cheap flows or raise it for genuinely multi-step planning prompts.
   */
  maxAttempts?: number;
  /**
   * Optional caller abort signal. Merged with the per-call hard timeout inside
   * `AiSdkModel` so the stricter of (caller abort, timeout) bounds every
   * provider round-trip in the submit/abort tool loop.
   */
  signal?: AbortSignal;
}

export interface SubkitLlmTelemetryMetadata {
  tenant_id: string;
  flow: LlmFlow;
  conversation_id?: string;
  [key: string]: string | number | boolean | undefined;
}

/** Provider-error kinds the fallback layer recognizes. */
export type SubkitProviderErrorKind =
  | "rate_limit"
  | "quota_exhausted"
  | "overloaded"
  | "context_length_exceeded"
  | "network_5xx"
  | "timeout"
  | "other";

export interface SubkitLlm {
  contextLength: number;
  modelId: string;
  generateText(
    messages: SubkitLlmMessage[],
    opts?: {
      temperature?: number;
      metadata?: SubkitLlmTelemetryMetadata;
      /** Caller abort signal (P1) — merged with the per-call timeout
       *  ceiling inside the implementation. */
      signal?: AbortSignal;
      /** Output ceiling for short answers; unset leaves the provider default. */
      maxOutputTokens?: number;
    },
  ): Promise<SubkitLlmResponse>;
  generateObject<T>(
    input: SubkitLlmObjectGeneratorInput & { metadata?: SubkitLlmTelemetryMetadata },
  ): Promise<SubkitLlmObjectResponse<T>>;
}
