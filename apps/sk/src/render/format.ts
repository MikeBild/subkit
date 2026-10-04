export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function executionDurationMs(startedAt: unknown, finishedAt: unknown): number | null {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const d = end - start;
  return d >= 0 ? d : null;
}

export interface StepBottleneck {
  step_key: string;
  kind: string | null;
  connector_slug: string | null;
  duration_ms: number;
  pct: number;
}

export function computeStepBottlenecks(
  steps: ReadonlyArray<Record<string, unknown>>,
): StepBottleneck[] {
  const rows: Array<Omit<StepBottleneck, "pct">> = [];
  let total = 0;
  for (const s of steps) {
    const d = s.duration_ms;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) continue;
    total += d;
    const rm = (s.request_meta ?? null) as Record<string, unknown> | null;
    const conn = (rm?.connector ?? null) as Record<string, unknown> | null;
    rows.push({
      step_key: typeof s.step_key === "string" ? s.step_key : "(step)",
      kind: typeof s.kind === "string" ? s.kind : null,
      connector_slug: typeof conn?.slug === "string" ? conn.slug : null,
      duration_ms: d,
    });
  }
  return rows
    .map((r) => ({
      ...r,
      pct: total > 0 ? Math.round((r.duration_ms / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.duration_ms - a.duration_ms);
}
