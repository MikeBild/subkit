// Shared, pure formatting + telemetry-shaping helpers used across the
// REPL footer, the `executions`/`stats`/`health` commands, and the run
// summary path. These exist so the CLI renders one consistent token,
// duration, and bottleneck representation everywhere — pre-consolidation
// `formatTokens` lived only in `repl/footer.tsx` and `humanMs` only in
// `commands/stats.ts`, and every other surface hand-rolled its own.
//
// No Ink / React imports — this is a leaf module so both the scripted
// command surfaces (`process.stdout.write`) and the Ink components can
// depend on it without dragging the render runtime into the headless
// build.

/** Compact `1.2k` / `4.8M` token formatting. Used by the budget line in
 *  the footer and any command surfacing a token figure. `null`/absent →
 *  an en-dash so the column stays aligned. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** Human-readable duration from a millisecond count: `840ms`, `1.4s`,
 *  `3.2m`, `1.1h`. Non-finite / non-positive → `0ms`. Shared by stats,
 *  executions, and health so latency reads the same on every surface. */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Duration of an execution from its `started_at` / `finished_at`
 *  timestamps. Returns `null` for a still-running (or never-finished)
 *  row so callers can render "running"/blank rather than a bogus zero. */
export function executionDurationMs(startedAt: unknown, finishedAt: unknown): number | null {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const d = end - start;
  return d >= 0 ? d : null;
}

/** A single step's share of total step time, used by the execution
 *  bottleneck view and the inline run-summary "slowest step" line. */
export interface StepBottleneck {
  step_key: string;
  kind: string | null;
  /** Connector slug when the step resolved one, else `null`. */
  connector_slug: string | null;
  duration_ms: number;
  /** Percentage of the summed step duration (0–100), rounded to 0.1. */
  pct: number;
}

/** Compute each step's `duration_ms` as a percentage of the summed step
 *  duration, sorted slowest-first. Steps with no numeric `duration_ms`
 *  are dropped (they contribute neither to the total nor the ranking).
 *  Accepts the loosely-typed step rows the engine returns from
 *  `/v1/executions/{id}/steps` and the `RunExecutionStepSummary` shape
 *  the run path carries, so one computation drives both surfaces. */
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
