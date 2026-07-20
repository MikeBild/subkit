// Park-and-retry planning for provider usage-limit failures on the
// `conversation.run-turn` queue.
//
// The queue runs with `retryLimit:0` because a turn makes real,
// non-idempotent LLM + external calls — but that policy was written for
// SEMANTIC failures. A provider quota/rate-limit error ("You have reached
// your specified API usage limits. You will regain access on 2026-08-01 at
// 00:00 UTC.") is not a property of the turn at all: the model never ran,
// nothing was double-charged, and failing the task terminally LOSES the
// user's turn over a condition that resolves by itself. Observed in
// production as a `job.failed` that burned a whole turn on a quota window.
//
// `planProviderLimitPark` classifies the thrown error via the shared
// provider-error classifier and, for quota/rate-limit kinds only, returns a
// bounded re-enqueue plan: park until the provider's own reset time when the
// message carries one, else a per-kind backoff. Everything else (semantic
// failures, overloaded, context length) returns null and keeps the existing
// terminal-failure path. The worker re-enqueues a FRESH job with
// `startAfter` — pg-boss retry machinery stays untouched, so the
// retryLimit:0 contract for real failures is preserved.

import { buildProviderErrorDetails, classifyProviderError } from "../../llm/provider-errors.ts";

/** Parks are bounded: a provider that keeps answering with a limit error
 *  past this many re-enqueues gets the terminal-failure path so the task
 *  cannot ping-pong forever. */
export const PROVIDER_LIMIT_PARK_MAX = 3;
/** Backoff when a rate-limit error carries no reset time — short, the
 *  window is typically seconds to minutes. Doubles per park. */
export const RATE_LIMIT_PARK_BASE_DELAY_MS = 60_000;
/** Backoff when a quota error carries no reset time — quota windows are
 *  hours to a month, so probing more often than this is pointless. */
export const QUOTA_PARK_BASE_DELAY_MS = 15 * 60_000;
/** Ceiling on how far into the future a provider-supplied reset time may
 *  park a turn. Guards against garbage parses ("regain access on 2099-…")
 *  pinning a job for years; a monthly quota window fits comfortably. */
export const PROVIDER_LIMIT_PARK_MAX_HORIZON_MS = 45 * 24 * 60 * 60_000;

export interface ProviderLimitParkPlan {
  kind: "quota_exhausted" | "rate_limit";
  /** When the re-enqueued job becomes runnable. */
  start_after: Date;
  /** Total parks including this one — carried on the job envelope. */
  parks: number;
  /** Whether the delay came from the provider's stated reset time or from
   *  the per-kind default backoff. */
  source: "provider_reset" | "default_backoff";
}

/**
 * Decide whether a failed turn should be parked and re-enqueued instead of
 * terminally failed. Returns null when the error is not a provider
 * usage-limit error or the park budget is spent.
 */
export function planProviderLimitPark(
  err: unknown,
  priorParks: number,
  nowMs: number,
): ProviderLimitParkPlan | null {
  const kind = classifyProviderError(err);
  if (kind !== "quota_exhausted" && kind !== "rate_limit") return null;
  if (priorParks >= PROVIDER_LIMIT_PARK_MAX) return null;

  const base = kind === "rate_limit" ? RATE_LIMIT_PARK_BASE_DELAY_MS : QUOTA_PARK_BASE_DELAY_MS;
  const backoffMs = base * 2 ** priorParks;

  // Prefer the provider's own reset time ("You will regain access on
  // 2026-08-01 at 00:00 UTC") — parked exactly until then, capped at the
  // horizon. A reset in the past (clock skew, stale message) or an
  // unparseable one falls back to the default backoff.
  const retryAtRaw = buildProviderErrorDetails(err)?.retry_at;
  if (typeof retryAtRaw === "string") {
    const retryAtMs = Date.parse(retryAtRaw);
    if (!Number.isNaN(retryAtMs) && retryAtMs > nowMs) {
      return {
        kind,
        start_after: new Date(Math.min(retryAtMs, nowMs + PROVIDER_LIMIT_PARK_MAX_HORIZON_MS)),
        parks: priorParks + 1,
        source: "provider_reset",
      };
    }
  }
  return {
    kind,
    start_after: new Date(nowMs + backoffMs),
    parks: priorParks + 1,
    source: "default_backoff",
  };
}
