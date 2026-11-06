import { buildProviderErrorDetails, classifyProviderError } from "../../llm/provider-errors.ts";

export const PROVIDER_LIMIT_PARK_MAX = 3;
export const RATE_LIMIT_PARK_BASE_DELAY_MS = 60_000;
export const QUOTA_PARK_BASE_DELAY_MS = 15 * 60_000;
export const PROVIDER_LIMIT_PARK_MAX_HORIZON_MS = 45 * 24 * 60 * 60_000;

interface ProviderLimitParkPlan {
  kind: "quota_exhausted" | "rate_limit";
  start_after: Date;
  parks: number;
  source: "provider_reset" | "default_backoff";
}

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
