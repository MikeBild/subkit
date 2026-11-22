import { LlmGenerationAborted, LlmProviderError } from "./errors.ts";
import type { SubkitProviderErrorKind } from "./runtime/base-types.ts";

const QUOTA_PATTERNS = [
  "usage limit",
  "usage limits",
  "specified api usage limits",
  "insufficient_quota",
  "quota exceeded",
  "quota exhausted",
  "credit balance",
  "billing hard limit",
  "monthly spend limit",
  "limit reached",
] as const;

const NETWORK_PATTERNS = [
  "overloaded",
  "service unavailable",
  "timeout",
  "econnrefused",
  "etimedout",
  "rate limit",
  "temporarily unavailable",
  "internal server error",
  "503",
  "500",
  "502",
  "504",
  "529",
  "context_length",
  "too many tokens",
] as const;

const KEY_REJECTED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

interface ErrorShape {
  statusCode?: unknown;
  status?: unknown;
  message?: string;
  lastError?: unknown;
}

function ownStatus(err: ErrorShape | undefined): number | null {
  if (typeof err?.statusCode === "number") return err.statusCode;
  if (typeof err?.status === "number") return err.status;
  return null;
}

function statusOf(err: unknown): number | null {
  const anyErr = err as ErrorShape | undefined;
  return ownStatus(anyErr) ?? ownStatus(anyErr?.lastError as ErrorShape | undefined);
}

function readErrorParts(err: unknown): { statusCode: number | null; message: string } {
  const anyErr = err as ErrorShape | undefined;
  const message = (anyErr?.message ?? String(err ?? "")).toLowerCase();
  return { statusCode: statusOf(err), message };
}

export function classifyProviderError(err: unknown): SubkitProviderErrorKind {
  if (err instanceof LlmGenerationAborted) return "other";
  if (err instanceof LlmProviderError && err.kind !== "other") return err.kind;
  const { statusCode, message } = readErrorParts(err);
  if (statusCode !== null && KEY_REJECTED_STATUSES.has(statusCode)) return "key_rejected";

  if (message.includes("context_length") || message.includes("too many tokens")) {
    return "context_length_exceeded";
  }
  if (QUOTA_PATTERNS.some((pattern) => message.includes(pattern))) {
    return "quota_exhausted";
  }
  if (statusCode === 429 || message.includes("rate limit")) return "rate_limit";
  if (message.includes("overloaded") || statusCode === 529) return "overloaded";
  if (message.includes("timeout") || message.includes("etimedout")) return "timeout";
  if (statusCode !== null && (statusCode >= 500 || statusCode === 503)) return "network_5xx";
  if (NETWORK_PATTERNS.some((pattern) => message.includes(pattern))) return "network_5xx";
  return "other";
}

export function usageResultOf(err: unknown): "error" | "key_rejected" {
  return classifyProviderError(err) === "key_rejected" ? "key_rejected" : "error";
}

export function isFallbackEligible(err: unknown): boolean {
  const kind = classifyProviderError(err);
  return (
    kind === "rate_limit" ||
    kind === "quota_exhausted" ||
    kind === "overloaded" ||
    kind === "context_length_exceeded" ||
    kind === "network_5xx" ||
    kind === "timeout"
  );
}

export function shouldFallBack(
  err: unknown,
  primaryProvider: string,
  fallbackProvider: string,
): boolean {
  if (!isFallbackEligible(err)) return false;
  return !(
    classifyProviderError(err) === "quota_exhausted" && primaryProvider === fallbackProvider
  );
}

function parseRetryAt(message: string): string | null {
  const regainAccessUtc = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) utc/i.exec(
    message,
  );
  if (regainAccessUtc?.[1] && regainAccessUtc[2]) {
    return new Date(`${regainAccessUtc[1]}T${regainAccessUtc[2]}:00.000Z`).toISOString();
  }
  const regainAccess = /regain access on ([^.]+)/i.exec(message);
  if (regainAccess?.[1]) {
    const retryAt = regainAccess[1].trim();
    const parsed = new Date(retryAt);
    return Number.isNaN(parsed.getTime()) ? retryAt : parsed.toISOString();
  }
  const retryAfter = /retry after ([^.]+)/i.exec(message);
  if (retryAfter?.[1]) {
    const retryAt = retryAfter[1].trim();
    const parsed = new Date(retryAt);
    return Number.isNaN(parsed.getTime()) ? retryAt : parsed.toISOString();
  }
  return null;
}

export function buildProviderErrorDetails(err: unknown): Record<string, unknown> | undefined {
  const anyErr = err as ErrorShape | undefined;
  const statusCode = statusOf(err);
  const message = anyErr?.message ?? (err instanceof Error ? err.message : String(err));
  const retryAt = parseRetryAt(message);
  const details: Record<string, unknown> = {};
  if (statusCode !== null) details.upstream_status = statusCode;
  if (retryAt) details.retry_at = retryAt;
  return Object.keys(details).length > 0 ? details : undefined;
}

export function llmProviderErrorKind(err: unknown): LlmProviderError["kind"] {
  const kind = classifyProviderError(err);
  return kind === "network_5xx" || kind === "timeout" ? "other" : kind;
}

export function toLlmProviderError(err: unknown): LlmProviderError {
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(llmProviderErrorKind(err), message, buildProviderErrorDetails(err));
}

export function isToolSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:input_schema|invalid schema for (?:function|tool)|function[.]parameters|tools[.[]\d+.*schema)/i.test(
    message,
  );
}
