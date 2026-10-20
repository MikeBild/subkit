import { eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { selfHealingScans } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import {
  recordProactiveDriftCandidate,
  recordProactiveDriftScan,
  recordProactiveDriftSignal,
  recordProactiveDriftUnanchored,
} from "../observability/instrumentation.ts";
import {
  driftSignalContext,
  processDriftSignal,
  scanForDrift,
  sweepUndecidableCandidates,
} from "../self-healing/index.ts";

export async function runProactiveDriftScanForTenant(
  tenant_id: string,
  started: Date,
  db: Db,
): Promise<void> {
  const filters = { tenant_id };
  const [scanRow] = await db
    .insert(selfHealingScans)
    .values({
      tenant_id,
      source: "scheduler",
      filters,
      status: "running",
    })
    .returning({ id: selfHealingScans.id });
  if (!scanRow) {
    logger.error({
      module: "scheduler",
      action: "drift_scan.row_insert_failed",
      msg: "could not persist self_healing_scans row — skipping scan",
      tenant_id,
    });
    return;
  }
  const scan_id = scanRow.id;

  let signals_detected = 0;
  let candidates_created = 0;
  let unanchored_detected = 0;
  let errorText: string | null = null;
  let signalFailures = 0;
  try {
    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.SELF_HEALING_SCAN_TRIGGERED,
        resource_type: "self_healing_scan",
        resource_id: scan_id,
        result: "success",
        metadata: { source: "scheduler", filters },
      },
      db,
    );

    try {
      await sweepUndecidableCandidates(db, tenant_id);
    } catch (err) {
      errorText = "undecidable-candidate sweep failed";
      logger.error({
        module: "scheduler",
        action: "drift_scan.sweep_failed",
        msg: "undecidable-candidate sweep failed — drift scan continues",
        tenant_id,
        scan_id,
        ...errorFields(err),
      });
    }
    const scan = await scanForDrift(filters, db);
    signals_detected = scan.signals.length + scan.unanchored.length;
    unanchored_detected = scan.unanchored.length;
    for (const u of scan.unanchored) {
      recordProactiveDriftUnanchored({
        tenant_id,
        signal_type: u.signal.kind,
        reason: u.reason,
      });
    }
    for (const { signal, ctx } of scan.signals) {
      recordProactiveDriftSignal({ tenant_id, signal_type: signal.kind });
      try {
        const result = await processDriftSignal(
          signal,
          driftSignalContext(ctx, {
            actor_id: null,
            actor_type: "system",
            source: "proactive_scheduler",
            scan_id,
          }),
          { allowAutoApply: true },
          db,
        );
        if (result.created) {
          candidates_created += 1;
          recordProactiveDriftCandidate({ tenant_id, classification: result.classification });
        }
      } catch (err) {
        signalFailures++;
        logger.error({
          module: "scheduler",
          action: "drift_scan.signal_failed",
          msg: "failed to process drift signal — continuing with remaining signals",
          tenant_id,
          scan_id,
          drift_kind: signal.kind,
          ...errorFields(err),
        });
      }
    }
    if (signalFailures > 0) {
      const signalError = `${signalFailures} drift signal(s) failed`;
      errorText = errorText ? `${errorText}; ${signalError}` : signalError;
    }
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "scheduler",
      action: "drift_scan.failed",
      msg: "proactive drift scan failed mid-pass",
      tenant_id,
      scan_id,
      ...errorFields(err),
    });
  }

  const duration_ms = Date.now() - started.getTime();
  await db
    .update(selfHealingScans)
    .set({
      signals_detected,
      candidates_created,
      unanchored_detected,
      duration_ms,
      status: errorText === null ? "succeeded" : "failed",
      error: errorText,
      updated_at: new Date(),
    })
    .where(eq(selfHealingScans.id, scan_id));

  recordProactiveDriftScan({
    tenant_id,
    source: "scheduler",
    status: errorText === null ? "succeeded" : "failed",
    duration_ms,
  });

  await auditAwait(
    {
      tenant_id,
      actor_type: "system",
      action: AuditAction.SELF_HEALING_SCAN_COMPLETED,
      resource_type: "self_healing_scan",
      resource_id: scan_id,
      result: errorText === null ? "success" : "error",
      metadata: {
        source: "scheduler",
        signals_detected,
        candidates_created,
        unanchored_detected,
        duration_ms,
        ...(errorText ? { error: errorText } : {}),
      },
    },
    db,
  );

  logger.info({
    module: "scheduler",
    action: errorText === null ? "drift_scan.fired" : "drift_scan.failed",
    msg:
      errorText === null
        ? "proactive drift scan completed"
        : "proactive drift scan finished with error",
    tenant_id,
    scan_id,
    signals_detected,
    candidates_created,
    unanchored_detected,
    duration_ms,
    ...(errorText ? { error: errorText } : {}),
  });
}
