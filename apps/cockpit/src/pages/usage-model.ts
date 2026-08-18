export interface UsageRow {
  date: string;
  executions: number;
  average_duration_ms: number | null;
  p95_duration_ms: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The 30-day window the usage page reads. The engine rejects a call without it. */
export function usageStatsEndpoint(now = new Date()): string {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  return `/v1/stats/executions?bucket=day&from=${encodeURIComponent(from.toISOString())}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Flattens the grouped bucket envelope into one row per day.
 *
 * A bucket that carries no duration keeps `null`, not `0` — a day nobody
 * measured and a day that measured zero are different facts (CUI-SEV-2).
 */
export function usageRows(envelope: unknown): UsageRow[] {
  const groups = isRecord(envelope) && Array.isArray(envelope.groups) ? envelope.groups : [];
  return groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.buckets)) return [];
    return group.buckets.flatMap((bucket): UsageRow[] => {
      if (!isRecord(bucket) || typeof bucket.ts !== "string") return [];
      const duration = isRecord(bucket.duration_ms) ? bucket.duration_ms : {};
      return [
        {
          date: bucket.ts,
          executions: typeof bucket.executions === "number" ? bucket.executions : 0,
          average_duration_ms: numberOrNull(duration.avg),
          p95_duration_ms: numberOrNull(duration.p95),
        },
      ];
    });
  });
}

export interface UsageTotals {
  executions: number | null;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  successRatePercent: number | null;
}

const SUCCESS_STATUSES = ["completed", "succeeded", "success"] as const;

/** The four headline numbers. Each one is `null` when the engine did not send it. */
export function usageTotals(envelope: unknown): UsageTotals {
  const totals = isRecord(envelope) && isRecord(envelope.totals) ? envelope.totals : {};
  const executionsEnvelope = isRecord(totals.executions) ? totals.executions : {};
  const durations = isRecord(totals.duration_ms) ? totals.duration_ms : {};
  const count = numberOrNull(executionsEnvelope.count);
  const byStatus = isRecord(executionsEnvelope.by_status) ? executionsEnvelope.by_status : null;
  const succeeded = byStatus
    ? SUCCESS_STATUSES.reduce(
        (total, key) => total + (typeof byStatus[key] === "number" ? byStatus[key] : 0),
        0,
      )
    : null;
  return {
    executions: count,
    averageDurationMs: numberOrNull(durations.avg),
    p95DurationMs: numberOrNull(durations.p95),
    successRatePercent:
      count !== null && count > 0 && succeeded !== null
        ? Math.round((succeeded / count) * 100)
        : null,
  };
}

export function formatDurationMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}
