export const REPEATING_REPAIR_CODES = new Set([
  "unresolved_identifier",
  "loop_over_unresolved",
  "transform_empty_extraction",
]);

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
