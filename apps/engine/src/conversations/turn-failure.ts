// Why a conversation turn stopped, typed for the person reading it.
//
// A turn killed by the model provider reached every streaming client as
// `{ code: "internal" }` with the provider's English sentence as the only
// clue — while the same failure on the JSON branch was already answered as
// `llm_provider_limited` with a `retry_at`. The loop raises `LlmProviderError`
// with a classified kind and, for a dated quota, the time access returns;
// this keeps that on the way out, in the error envelope's own vocabulary, so
// a client can say "the provider's usage limit is reached until …" in the
// reader's language — on the live stream and on the stored `last_turn_error`.

import { APICallError } from "ai";
import { LlmError, LlmProviderError } from "../llm/errors.ts";
import { toLlmProviderError } from "../llm/provider-errors.ts";

/** The codes the HTTP error envelope uses for the same failures. */
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
  /** The provider error's classified kind (`quota_exhausted`, `rate_limit`, …). */
  kind?: LlmProviderError["kind"];
  /** When the provider says access returns; only on a limit it dated. */
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

/** The SSE `error` frame's payload for a failed turn. */
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
