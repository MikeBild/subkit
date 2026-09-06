// Retry policy primitives shared between `dispatch.ts` and tests.
//
//   - 5 attempts max (1 initial + 4 retries)
//   - 200ms base, 30s cap, +/- 20% jitter
//   - 429 honours `Retry-After` (cap 1h)
//   - GET / HEAD / OPTIONS retry on 5xx + 429 + connection errors
//   - POST / PUT / PATCH / DELETE retry only on 429 + connection errors
//
// Per-step overrides via `step.retry_backoff_ms` and
// `step.retry_on_status` (the latter extends the policy with an
// explicit opt-in for non-idempotent codes like 408 / 425).

import type { RequestStep } from "../../../workflows/types.ts";

export const RETRY_BASE_MS = 200;
export const RETRY_CAP_MS = 30_000;
export const REQUEST_MAX_RETRIES_DEFAULT = 4;

export function requestMaxAttempts(step: Pick<RequestStep, "max_retries">): number {
  return (step.max_retries ?? REQUEST_MAX_RETRIES_DEFAULT) + 1;
}

function jitter(ms: number): number {
  const j = ms * 0.2;
  return ms + (Math.random() * 2 - 1) * j;
}

export function backoffMs(attempt: number, base_ms: number = RETRY_BASE_MS): number {
  const raw = Math.min(RETRY_CAP_MS, base_ms * 2 ** attempt);
  return Math.max(0, jitter(raw));
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const numeric = Number.parseFloat(trimmed);
  if (Number.isFinite(numeric)) {
    return Math.max(0, numeric * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

export function isIdempotent(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export interface RetryPolicy {
  backoff_base_ms: number;
  additional_retry_statuses: Set<number>;
}

export function resolveRetryPolicy(step: RequestStep): RetryPolicy {
  return {
    backoff_base_ms: step.retry_backoff_ms ?? RETRY_BASE_MS,
    additional_retry_statuses: new Set(step.retry_on_status ?? []),
  };
}
