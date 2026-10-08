import type { FilePart, ImagePart, TextPart, Tool } from "ai";
import type { LlmFlow } from "../types.ts";

export interface SubkitLlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<TextPart | ImagePart | FilePart>;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface SubkitLlmAnsweredBy {
  model_used: string;
  fell_back: boolean;
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
}

export interface SubkitLlmObjectGeneratorInput {
  messages: SubkitLlmMessage[];
  schema: Record<string, unknown>;
  temperature?: number;
  tools?: SubkitLlmToolWithContext[];
  metadata?: Record<string, unknown>;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface SubkitLlmTelemetryMetadata {
  tenant_id: string;
  flow: LlmFlow;
  conversation_id?: string;
  [key: string]: string | number | boolean | undefined;
}

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
      signal?: AbortSignal;
      maxOutputTokens?: number;
    },
  ): Promise<SubkitLlmResponse>;
  generateObject<T>(
    input: SubkitLlmObjectGeneratorInput & { metadata?: SubkitLlmTelemetryMetadata },
  ): Promise<SubkitLlmObjectResponse<T>>;
}
