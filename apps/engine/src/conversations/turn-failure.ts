import { APICallError } from "ai";
import { LlmError, LlmProviderError } from "../llm/errors.ts";
import { toLlmProviderError } from "../llm/provider-errors.ts";

export type TurnFailureCode =
  | "llm_provider_limited"
  | "llm_provider_unavailable"
  | "llm_context_too_large"
  | "llm_quota_exhausted"
  | "internal";

export interface TurnFailure {
  code: TurnFailureCode;
  message: string;
  at: string;
  kind?: LlmProviderError["kind"];
  retry_at?: string;
}

function providerFailure(error: LlmProviderError, at: string): TurnFailure {
  const retryAt = error.details?.retry_at;
  const code: TurnFailureCode =
    error.kind === "context_length_exceeded"
      ? "llm_context_too_large"
      : error.kind === "rate_limit" || error.kind === "quota_exhausted"
        ? "llm_provider_limited"
        : "llm_provider_unavailable";
  return {
    code,
    message: error.message,
    at,
    kind: error.kind,
    ...(typeof retryAt === "string" ? { retry_at: retryAt } : {}),
  };
}

export function describeTurnFailure(error: unknown, now: Date = new Date()): TurnFailure {
  const at = now.toISOString();
  const providerErr =
    error instanceof LlmProviderError
      ? error
      : APICallError.isInstance(error)
        ? toLlmProviderError(error)
        : null;
  if (providerErr) return providerFailure(providerErr, at);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof LlmError && error.code === "llm_quota_exhausted") {
    return { code: "llm_quota_exhausted", message, at };
  }
  return { code: "internal", message: message || "internal_error", at };
}

export function turnFailureFramePayload(failure: TurnFailure): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  const details = {
    ...(failure.kind ? { kind: failure.kind } : {}),
    ...(failure.retry_at ? { retry_at: failure.retry_at } : {}),
  };
  return {
    code: failure.code,
    message: failure.message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}
