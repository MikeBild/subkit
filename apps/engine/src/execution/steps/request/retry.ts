import { backoffDelay } from "@shared/backoff.ts";
import type { RequestStep } from "../../../workflows/types.ts";

export const RETRY_BASE_MS = 200;
export const RETRY_CAP_MS = 30_000;
export const REQUEST_MAX_RETRIES_DEFAULT = 4;

export function requestMaxAttempts(step: Pick<RequestStep, "max_retries">): number {
  return (step.max_retries ?? REQUEST_MAX_RETRIES_DEFAULT) + 1;
}

export function backoffMs(
  attempt: number,
  base_ms: number = RETRY_BASE_MS,
  random: number = Math.random(),
): number {
  return backoffDelay(attempt, random, {
    baseMs: base_ms,
    maxMs: RETRY_CAP_MS,
    jitter: { symmetric: 0.2 },
    round: false,
  });
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
