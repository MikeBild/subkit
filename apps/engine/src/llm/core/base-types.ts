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
}

export interface SubkitLlmResponse {
  response: string;
  messages: SubkitLlmMessage[];
  usage: SubkitLlmUsage;
  finish_reason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";
}

export interface SubkitLlmObjectResponse<T> {
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
    opts?: { temperature?: number; metadata?: SubkitLlmTelemetryMetadata },
  ): Promise<SubkitLlmResponse>;
  generateObject<T>(
    input: SubkitLlmObjectGeneratorInput & { metadata?: SubkitLlmTelemetryMetadata },
  ): Promise<SubkitLlmObjectResponse<T>>;
}
