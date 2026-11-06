import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { AuditActorType } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { selfHealingScans } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  recordProactiveDriftCandidate,
  recordProactiveDriftScan,
  recordProactiveDriftSignal,
  recordProactiveDriftUnanchored,
} from "../observability/index.ts";
import { sweepUndecidableCandidates } from "./open-decisions.ts";
import { driftSignalContext, scanForDrift } from "./proactive-scanner.ts";
import { type ProcessSignalResult, processDriftSignal, type SignalSource } from "./service.ts";
import type { DriftSignal } from "./types.ts";

const IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SelfHealingScanRow = typeof selfHealingScans.$inferSelect;

export type ScanSource = "scheduler" | "admin_http" | "mcp";

export interface ScanActor {
  tenant_id: string;
  kind: AuditActorType;
  id: string | null;
}

export interface RunScanInput {
  source: ScanSource;
  signalSource: SignalSource;
  allowAutoApply: boolean;
  sweepUndecidable: boolean;
  countCreatedOnly: boolean;
  signalFailuresFailScan: boolean;
  workflow_id?: string | undefined;
  connector_id?: string | undefined;
  idempotency_key: string | null;
  started?: Date;
}

interface AdminScanInput {
  workflow_id?: string | undefined;
  connector_id?: string | undefined;
  idempotency_key: string | null;
}

export interface ScanCandidate {
  id: string;
  signal_type: DriftSignal["kind"];
  classification: ProcessSignalResult["classification"];
  status: ProcessSignalResult["status"];
}

export interface ScanUnanchored {
  signal_type: DriftSignal["kind"];
  reason: "hook_surface_not_supported" | "no_workflow_anchor";
  resource_id: string;
}

export interface ScanCompleted {
  scan_id: string;
  signals_detected: number;
  candidates_created: number;
  unanchored_detected: number;
  duration_ms: number;
  candidates: ScanCandidate[];
  unanchored: ScanUnanchored[];
  error: string | null;
}

export type ScanOutcome =
  | { kind: "replay"; scan: SelfHealingScanRow }
  | { kind: "completed"; result: ScanCompleted }
  | { kind: "not_persisted" };

type AdminScanOutcome = Exclude<ScanOutcome, { kind: "not_persisted" }>;

interface ListScansInput {
  status?: "running" | "succeeded" | "failed" | undefined;
  source?: "scheduler" | "admin_http" | "mcp" | undefined;
  limit: number;
}

async function findIdempotentHit(
  db: Db,
  tenantId: string,
  idempotencyKey: string | null,
): Promise<SelfHealingScanRow | undefined> {
  if (!idempotencyKey) return undefined;
  const cutoff = new Date(Date.now() - IDEMPOTENCY_REPLAY_WINDOW_MS);
  const cached = await db
    .select()
    .from(selfHealingScans)
    .where(
      and(
        eq(selfHealingScans.tenant_id, tenantId),
        eq(selfHealingScans.idempotency_key, idempotencyKey),
        gt(selfHealingScans.created_at, cutoff),
        inArray(selfHealingScans.status, ["succeeded", "failed"]),
      ),
    )
    .orderBy(desc(selfHealingScans.created_at))
    .limit(1);
  return cached[0];
}

function replay(
  tenantId: string,
  idempotencyKey: string | null,
  scan: SelfHealingScanRow,
): ScanOutcome {
  logger.info({
    module: "self-healing",
    action: "scan.idempotent_replay",
    msg: "returning prior scan result from idempotency cache",
    tenant_id: tenantId,
    scan_id: scan.id,
    idempotency_key: idempotencyKey,
  });
  return { kind: "replay", scan };
}

async function findConcurrentWinner(
  db: Db,
  tenantId: string,
  idempotencyKey: string,
): Promise<SelfHealingScanRow | undefined> {
  const concurrent = await db
    .select()
    .from(selfHealingScans)
    .where(
      and(
        eq(selfHealingScans.tenant_id, tenantId),
        eq(selfHealingScans.idempotency_key, idempotencyKey),
      ),
    )
    .orderBy(desc(selfHealingScans.created_at))
    .limit(1);
  return concurrent[0];
}

export async function runScan(db: Db, actor: ScanActor, input: RunScanInput): Promise<ScanOutcome> {
  const tenantId = actor.tenant_id;
  const idempotencyKey = input.idempotency_key;
  const source = input.source;
  const filters = {
    tenant_id: tenantId,
    ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
    ...(input.connector_id ? { connector_id: input.connector_id } : {}),
  };

  const hit = await findIdempotentHit(db, tenantId, idempotencyKey);
  if (hit) return replay(tenantId, idempotencyKey, hit);

  const started = input.started ?? new Date();
  const inserted = await db
    .insert(selfHealingScans)
    .values({
      tenant_id: tenantId,
      source,
      filters,
      actor_id: actor.id,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      status: "running",
    })
    .onConflictDoNothing({
      target: [selfHealingScans.tenant_id, selfHealingScans.idempotency_key],
    })
    .returning();
  const scanRow = inserted[0];
  if (!scanRow) {
    if (!idempotencyKey) return { kind: "not_persisted" };
    const winner = await findConcurrentWinner(db, tenantId, idempotencyKey);
    if (!winner) return { kind: "not_persisted" };
    return replay(tenantId, idempotencyKey, winner);
  }
  const scan_id = scanRow.id;

  let signals_detected = 0;
  let candidates_created = 0;
  let errorText: string | null = null;
  let signalFailures = 0;
  const candidates: ScanCandidate[] = [];
  const unanchored: ScanUnanchored[] = [];

  try {
    await auditAwait(
      {
        tenant_id: tenantId,
        actor_type: actor.kind,
        actor_id: actor.id,
        action: AuditAction.SELF_HEALING_SCAN_TRIGGERED,
        resource_type: "self_healing_scan",
        resource_id: scan_id,
        result: "success",
        metadata: { source, filters },
      },
      db,
    );
    if (input.sweepUndecidable) {
      try {
        await sweepUndecidableCandidates(db, tenantId);
      } catch (err) {
        errorText = "undecidable-candidate sweep failed";
        logger.error({
          module: "self-healing",
          action: "scan.sweep_failed",
          msg: "undecidable-candidate sweep failed — drift scan continues",
          source,
          scan_id,
          tenant_id: tenantId,
          ...errorFields(err),
        });
      }
    }
    const scan = await scanForDrift(filters, db);
    signals_detected = scan.signals.length + scan.unanchored.length;

    for (const u of scan.unanchored) {
      unanchored.push({
        signal_type: u.signal.kind,
        reason: u.reason,
        resource_id: u.resource_id,
      });
      recordProactiveDriftUnanchored({
        tenant_id: tenantId,
        signal_type: u.signal.kind,
        reason: u.reason,
      });
    }

    for (const { signal, ctx } of scan.signals) {
      recordProactiveDriftSignal({
        tenant_id: tenantId,
        signal_type: signal.kind,
      });
      try {
        const result = await processDriftSignal(
          signal,
          driftSignalContext(ctx, {
            actor_id: actor.id,
            actor_type: actor.kind,
            source: input.signalSource,
            scan_id,
          }),
          { allowAutoApply: input.allowAutoApply },
          db,
        );
        if (input.countCreatedOnly && !result.created) continue;
        candidates_created += 1;
        recordProactiveDriftCandidate({
          tenant_id: tenantId,
          classification: result.classification,
        });
        candidates.push({
          id: result.candidate_id,
          signal_type: signal.kind,
          classification: result.classification,
          status: result.status,
        });
      } catch (err) {
        signalFailures += 1;
        logger.error({
          module: "self-healing",
          action: "scan.signal_failed",
          msg: "failed to process drift signal — continuing",
          source,
          scan_id,
          tenant_id: tenantId,
          drift_kind: signal.kind,
          ...errorFields(err),
        });
      }
    }
    if (input.signalFailuresFailScan && signalFailures > 0) {
      const signalError = `${signalFailures} drift signal(s) failed`;
      errorText = errorText ? `${errorText}; ${signalError}` : signalError;
    }
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "self-healing",
      action: "scan.failed",
      msg: "drift scan failed mid-pass",
      source,
      scan_id,
      tenant_id: tenantId,
      ...errorFields(err),
    });
  }

  const duration_ms = Date.now() - started.getTime();
  await db
    .update(selfHealingScans)
    .set({
      signals_detected,
      candidates_created,
      unanchored_detected: unanchored.length,
      duration_ms,
      status: errorText === null ? "succeeded" : "failed",
      error: errorText,
      updated_at: new Date(),
    })
    .where(and(eq(selfHealingScans.tenant_id, tenantId), eq(selfHealingScans.id, scan_id)));

  recordProactiveDriftScan({
    tenant_id: tenantId,
    source,
    status: errorText === null ? "succeeded" : "failed",
    duration_ms,
  });

  await auditAwait(
    {
      tenant_id: tenantId,
      actor_type: actor.kind,
      actor_id: actor.id,
      action: AuditAction.SELF_HEALING_SCAN_COMPLETED,
      resource_type: "self_healing_scan",
      resource_id: scan_id,
      result: errorText === null ? "success" : "error",
      metadata: {
        source,
        signals_detected,
        candidates_created,
        unanchored_detected: unanchored.length,
        duration_ms,
        ...(errorText ? { error: errorText } : {}),
      },
    },
    db,
  );

  return {
    kind: "completed",
    result: {
      scan_id,
      signals_detected,
      candidates_created,
      unanchored_detected: unanchored.length,
      duration_ms,
      candidates,
      unanchored,
      error: errorText,
    },
  };
}

export async function runAdminScan(
  db: Db,
  actor: ScanActor & { id: string },
  input: AdminScanInput,
): Promise<AdminScanOutcome> {
  const outcome = await runScan(db, actor, {
    source: "admin_http",
    signalSource: "proactive_admin",
    allowAutoApply: false,
    sweepUndecidable: false,
    countCreatedOnly: false,
    signalFailuresFailScan: false,
    workflow_id: input.workflow_id,
    connector_id: input.connector_id,
    idempotency_key: input.idempotency_key,
  });
  if (outcome.kind === "not_persisted") throw new Error("failed to persist self_healing_scans row");
  return outcome;
}

export async function listScans(
  db: Db,
  tenantId: string,
  input: ListScansInput,
): Promise<SelfHealingScanRow[]> {
  const tenantPredicate = eq(selfHealingScans.tenant_id, tenantId);
  const extras = [];
  if (input.status) extras.push(eq(selfHealingScans.status, input.status));
  if (input.source) extras.push(eq(selfHealingScans.source, input.source));
  return db
    .select()
    .from(selfHealingScans)
    .where(extras.length > 0 ? and(tenantPredicate, ...extras) : tenantPredicate)
    .orderBy(desc(selfHealingScans.created_at))
    .limit(input.limit);
}

export async function getScan(
  db: Db,
  tenantId: string,
  id: string,
): Promise<SelfHealingScanRow | null> {
  const rows = await db
    .select()
    .from(selfHealingScans)
    .where(and(eq(selfHealingScans.tenant_id, tenantId), eq(selfHealingScans.id, id)))
    .limit(1);
  return rows[0] ?? null;
}
