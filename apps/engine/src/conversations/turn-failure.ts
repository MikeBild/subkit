import { APICallError } from "ai";
import {
  HostedResourceCountError,
  HostedStorageQuotaError,
  hostedQuotaError,
} from "../db/hosted-quota-errors.ts";
import { LlmError, LlmProviderError } from "../llm/errors.ts";
import { toLlmProviderError } from "../llm/provider-errors.ts";
import { isDatabaseQueryError } from "../logging/index.ts";

export type TurnFailureCode =
  | "hosted_storage_quota_exhausted"
  | "hosted_resource_count_exhausted"
  | "llm_provider_limited"
  | "llm_provider_unavailable"
  | "llm_context_too_large"
  | "llm_quota_exhausted"
  | "llm_timeout"
  | "internal";

export type TimeoutPhase = "total" | "first_chunk" | "step" | "chunk";

export interface TurnFailure {
  code: TurnFailureCode;
  message: string;
  at: string;
  kind?: LlmProviderError["kind"];
  retry_at?: string;
  timeout?: { phase: TimeoutPhase; timeout_ms: number | null };
}

export function timeoutMessage(timeout_ms: number): string {
  return `Timed out after ${Math.ceil(timeout_ms / 1000)} s`;
}

export class LlmTimeoutError extends Error {
  override readonly name = "TimeoutError";
  readonly phase: TimeoutPhase;
  readonly timeout_ms: number;

  constructor(phase: TimeoutPhase, timeout_ms: number, options?: { cause?: unknown }) {
    super(timeoutMessage(timeout_ms), options);
    this.phase = phase;
    this.timeout_ms = timeout_ms;
  }
}

export function timeoutPhaseOf(error: unknown): TimeoutPhase | null {
  if (error instanceof LlmTimeoutError) return error.phase;
  if (!(error instanceof Error) || error.name !== "TimeoutError") return null;
  if (error.message.startsWith("Step ")) return "step";
  if (error.message.startsWith("First chunk ")) return "first_chunk";
  if (error.message.startsWith("Chunk ")) return "chunk";
  return "total";
}

const SDK_TIMEOUT_MS_RE = /timeout of (\d+)ms exceeded/;

export function timeoutBudgetOf(error: unknown): number | null {
  if (error instanceof LlmTimeoutError) return error.timeout_ms;
  const match = error instanceof Error ? SDK_TIMEOUT_MS_RE.exec(error.message) : null;
  return match?.[1] ? Number(match[1]) : null;
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
  const quota = hostedQuotaError(error);
  if (quota instanceof HostedStorageQuotaError || quota instanceof HostedResourceCountError)
    return { code: quota.code, message: quota.message, at };
  const seen = new Set<unknown>();
  let cause: unknown = error;
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    if (isDatabaseQueryError(cause))
      return { code: "internal", message: "The conversation could not be saved.", at };
    cause = (cause as { cause?: unknown }).cause;
  }
  const providerErr =
    error instanceof LlmProviderError
      ? error
      : APICallError.isInstance(error)
        ? toLlmProviderError(error)
        : null;
  if (providerErr) return providerFailure(providerErr, at);
  const phase = timeoutPhaseOf(error);
  if (phase) {
    const timeout_ms = timeoutBudgetOf(error);
    return {
      code: "llm_timeout",
      message: timeout_ms === null ? "Timed out" : timeoutMessage(timeout_ms),
      at,
      timeout: { phase, timeout_ms },
    };
  }
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
    ...(failure.timeout
      ? {
          phase: failure.timeout.phase,
          ...(failure.timeout.timeout_ms !== null
            ? { timeout_ms: failure.timeout.timeout_ms }
            : {}),
        }
      : {}),
  };
  return {
    code: failure.code,
    message: failure.message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}
