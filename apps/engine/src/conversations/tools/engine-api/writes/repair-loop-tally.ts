// Pure tally for the run_workflow / dry_run_workflow circuit-breaker.
// Split out of run-workflow.ts so the counting logic can be unit-tested
// with synthetic envelopes (no DB) and so the tool module stays under
// the 1000-LOC ceiling. `detectRepairLoop` fetches the rows and delegates
// here.

/**
 * Codes that count toward the repair-loop circuit breaker. Each one
 * means "the JSONata path or template doesn't actually resolve to
 * data the engine can use" — so a re-run with the same draft will
 * produce the same warning. Three of any of these codes in the
 * recent history (per-code, not summed) trips the breaker.
 */
export const REPEATING_REPAIR_CODES = new Set([
  "unresolved_identifier",
  "loop_over_unresolved",
  "transform_empty_extraction",
]);

/** Minimum identical trip signals before the breaker fires. */
export const REPAIR_LOOP_TRIP_THRESHOLD = 3;

export interface RepairSignalRow {
  tool: string;
  output: unknown;
}

export interface RepairLoopVerdict {
  tripped: boolean;
  recent_codes: string[];
  tripped_codes: Array<{ code: string; count: number }>;
}

/**
 * Pure tally over recent `run_workflow` / `dry_run_workflow` rows.
 * Counts two trip signals:
 *   (1) a repeating authoring-bug warning (see `REPEATING_REPAIR_CODES`)
 *       — "the LLM is stuck rewriting the same JSONata five different
 *       ways and every attempt produces the same warning";
 *   (2) a repeating RUNTIME execution failure keyed on
 *       `exec_failed:<step>:<error_code>` — "the same connector call
 *       keeps failing the same way" (e.g. 14× GET /v1/pages/<a-human-name>
 *       → http 400). These carry NO warning code, so without this they
 *       ran the loop to the step-budget cap with no clear signal.
 * Three identical occurrences of either signal trip the breaker.
 */
export function tallyRepairSignals(rows: RepairSignalRow[]): RepairLoopVerdict {
  const codes: string[] = [];
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.tool !== "run_workflow" && r.tool !== "dry_run_workflow") continue;
    const data = r.output as {
      data?: {
        status?: unknown;
        failure_step_key?: unknown;
        step_trace?: Array<{ status?: unknown; error_code?: unknown }>;
        warnings?: Array<{ code?: unknown }>;
      };
    } | null;
    // (1) Repeating authoring-bug warning codes (JSONata / loop scope).
    const ws = data?.data?.warnings;
    if (Array.isArray(ws)) {
      for (const w of ws) {
        if (w && typeof w.code === "string") {
          codes.push(w.code);
          if (REPEATING_REPAIR_CODES.has(w.code)) {
            counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
          }
        }
      }
    }
    // (2) Repeated RUNTIME execution failures. A run that ends
    // `status: "failed"` carries no authoring-bug warning code, so the
    // warning loop above never sees it — yet 14 identical connector
    // HTTP 4xx failures (e.g. GET /v1/pages/<a-human-name> → 400) are
    // the same "this strategy isn't working" spiral that burns the
    // whole step budget. Key on the failing step + its error code so a
    // genuinely different failure doesn't pile into the same bucket.
    if (data?.data?.status === "failed") {
      const trace = Array.isArray(data.data.step_trace) ? data.data.step_trace : [];
      const failed = trace.find((s) => s?.status === "failed" || s?.status === "timed_out");
      const errCode =
        failed && typeof failed.error_code === "string" ? failed.error_code : "exec_error";
      const stepKey =
        typeof data.data.failure_step_key === "string" ? data.data.failure_step_key : "?";
      const key = `exec_failed:${stepKey}:${errCode}`;
      codes.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const tripped_codes = [...counts.entries()]
    .filter(([, n]) => n >= REPAIR_LOOP_TRIP_THRESHOLD)
    .map(([code, n]) => ({ code, count: n }));
  return {
    tripped: tripped_codes.length > 0,
    recent_codes: codes.slice(0, 8),
    tripped_codes,
  };
}
