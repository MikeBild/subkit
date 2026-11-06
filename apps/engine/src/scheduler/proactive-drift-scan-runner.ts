import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { runScan } from "../self-healing/admin-scans.ts";

export async function runProactiveDriftScanForTenant(
  tenant_id: string,
  started: Date,
  db: Db,
): Promise<void> {
  const outcome = await runScan(
    db,
    { tenant_id, kind: "system", id: null },
    {
      source: "scheduler",
      signalSource: "proactive_scheduler",
      allowAutoApply: true,
      sweepUndecidable: true,
      countCreatedOnly: true,
      signalFailuresFailScan: true,
      idempotency_key: null,
      started,
    },
  );
  if (outcome.kind !== "completed") {
    logger.error({
      module: "scheduler",
      action: "drift_scan.row_insert_failed",
      msg: "could not persist self_healing_scans row — skipping scan",
      tenant_id,
    });
    return;
  }
  const { scan_id, signals_detected, candidates_created, unanchored_detected, duration_ms, error } =
    outcome.result;
  logger.info({
    module: "scheduler",
    action: error === null ? "drift_scan.fired" : "drift_scan.failed",
    msg:
      error === null
        ? "proactive drift scan completed"
        : "proactive drift scan finished with error",
    tenant_id,
    scan_id,
    signals_detected,
    candidates_created,
    unanchored_detected,
    duration_ms,
    ...(error ? { error } : {}),
  });
}
