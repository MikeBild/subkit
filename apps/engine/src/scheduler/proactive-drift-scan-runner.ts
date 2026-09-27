// Per-tenant runner for the scheduler's proactive drift scan reconciler.
//
// Extracted out of `reconciler.ts` to keep that file under the 1000-LOC
// ceiling enforced by the audit-invariants gate. The reconciler still
// owns the cadence + CAS-stamp logic (which tenant fires when across
// multiple engine instances); this module owns the per-tenant scan
// execution: insert the self_healing_scans row, fan out to scanForDrift
// + processDriftSignal, update the row with counters + status, and
// emit audit + metric signals along the way.
//
// Kept isolated to a single exported function so reconciler.ts has a
// thin call site and the audit-invariants `file_size` gate stays green.

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

/**
 * Execute one proactive drift scan for a single tenant.
 *
 * Inserts a `self_healing_scans` row in `status='running'`, runs the
 * scanner, drives `processDriftSignal({ allowAutoApply: true })` on
 * each emitted signal (the dedup guard + policy keep unsafe patches
 * parked and already-healed endpoints untouched), updates the row with
 * counters + final status,
 * emits the SELF_HEALING_SCAN_TRIGGERED and SELF_HEALING_SCAN_COMPLETED
 * audit rows, and records the Prometheus metrics.
 *
 * Per-tenant scan failures land as `status='failed'` on the row with
 * the error text; the reconciler keeps sweeping the other tenants.
 */
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
  try {
    // The TRIGGERED audit lives inside the try/finally so an audit-
    // insert failure here still gets the scan row finalised below
    // (rather than leaving an orphan `status='running'` row that the
    // CAS-stamp blocks from retry for a full cadence).
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

    // Close the proposed candidates the current workflow versions prove
    // undecidable before scanning, so a closed row's signal meets the
    // version-bound terminal dedup instead of being re-proposed.
    await sweepUndecidableCandidates(db, tenant_id);
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
            source: "proactive_scheduler",
            scan_id,
          }),
          // Auto-apply `safe` rename/widening drift so a clean proactive
          // signal heals itself instead of parking forever. The policy
          // still parks anything unsafe, and the endpoint dedup guard in
          // processDriftSignal stops re-applying an already-healed
          // endpoint on the next tick.
          { allowAutoApply: true },
          db,
        );
        // Count only fresh inserts. A dedup refresh of a still-open
        // candidate returns a result too — counting those reported
        // "3 created" every hour while nothing new was proposed.
        if (result.created) {
          candidates_created += 1;
          recordProactiveDriftCandidate({ tenant_id, classification: result.classification });
        }
      } catch (err) {
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
