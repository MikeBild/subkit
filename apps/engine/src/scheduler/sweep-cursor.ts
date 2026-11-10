import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  type SchedulerSweepProducer,
  schedulerSweepCursors,
  schedulerSweepProducerEnum,
} from "../db/schema/index.ts";
import { sweepSource } from "./sweep-cursor-source.ts";

export const SWEEP_PAGE_LIMIT = 64;
export const SWEEP_METADATA_MAX_BYTES = 16 * 1024;
export const SWEEP_LEASE_MS = 60_000;
const SWEEP_VISIT_WINDOW_MS = 5_000;
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const databaseDate = z.union([z.date(), z.string().max(40).pipe(z.coerce.date())]);
const producerSchema = z.enum(schedulerSweepProducerEnum.enumValues);
const candidateSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    created_at: z.date(),
  })
  .strict();
const cursorSchema = z
  .object({
    producer: producerSchema,
    epoch: counter,
    revision: counter,
    after_id: z.string().uuid().nullable(),
    epoch_upper_id: z.string().uuid().nullable(),
    epoch_cutoff_at: z.date().nullable(),
    lease_owner_boot_id: z.string().uuid().nullable(),
    lease_token: z.string().uuid().nullable(),
    lease_until: z.date().nullable(),
    updated_at: z.date(),
  })
  .strict();
const leaseSchema = z
  .object({
    producer: producerSchema,
    epoch: counter,
    revision: counter,
    after_id: z.string().uuid().nullable(),
    epoch_upper_id: z.string().uuid(),
    epoch_cutoff_at: z.date(),
    owner_boot_id: z.string().uuid(),
    lease_token: z.string().uuid(),
    lease_until: z.date(),
  })
  .strict();

export type SweepCandidate = z.infer<typeof candidateSchema>;
export type SweepLease = z.infer<typeof leaseSchema>;
type Cursor = z.infer<typeof cursorSchema>;
export interface SweepPage {
  lease: SweepLease;
  candidates: readonly SweepCandidate[];
}
export type SweepAcquireResult =
  | { kind: "busy" }
  | { kind: "empty"; epoch: number; revision: number }
  | ({ kind: "claimed" } & SweepPage);
export type SweepLostLease = { kind: "lost_lease" };
const lost: SweepLostLease = { kind: "lost_lease" };
const ownedPages = new WeakSet<SweepPage>();

export class SweepCursorError extends Error {
  constructor(
    readonly code:
      | "sweep_cursor_missing"
      | "sweep_counter_exhausted"
      | "sweep_metadata_invalid"
      | "sweep_page_unowned"
      | "sweep_clock_unavailable",
  ) {
    super(code);
    this.name = "SweepCursorError";
  }
}

function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new SweepCursorError("sweep_counter_exhausted");
  return value + 1;
}

export async function boundedTransaction<T>(db: Db, run: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT
      set_config('statement_timeout', LEAST(COALESCE(NULLIF(EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000, 0), 2000), 2000)::bigint::text, true),
      set_config('lock_timeout', LEAST(COALESCE(NULLIF(EXTRACT(EPOCH FROM current_setting('lock_timeout')::interval) * 1000, 0), 100), 100)::bigint::text, true)`);
    return run(tx);
  });
}

async function lockCursor(
  tx: Executor,
  producer: SchedulerSweepProducer,
  mode: "share" | "update",
  noWait = true,
): Promise<Cursor> {
  // tenant-filter:exempt — fixed instance scheduler cursor enum has eight operational rows
  const [row] = await tx
    .select()
    .from(schedulerSweepCursors)
    .where(eq(schedulerSweepCursors.producer, producer))
    .for(mode, noWait ? { noWait: true } : undefined);
  if (!row) throw new SweepCursorError("sweep_cursor_missing");
  return cursorSchema.parse(row);
}

function sameLease(row: Cursor, lease: SweepLease): boolean {
  return (
    row.producer === lease.producer &&
    row.epoch === lease.epoch &&
    row.revision === lease.revision &&
    row.lease_owner_boot_id === lease.owner_boot_id &&
    row.lease_token === lease.lease_token &&
    row.after_id === lease.after_id &&
    row.epoch_upper_id === lease.epoch_upper_id &&
    row.epoch_cutoff_at?.getTime() === lease.epoch_cutoff_at.getTime()
  );
}

async function databaseTime(tx: Executor, row: Cursor): Promise<{ at: Date; live: boolean }> {
  const result = await tx.execute<{ at: Date; live: boolean }>(sql`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS at,
      COALESCE(${row.lease_until}::timestamptz > clock_timestamp(), false) AS live`);
  const value = z.object({ at: databaseDate, live: z.boolean() }).strict().parse(result.rows[0]);
  if (value.at.getTime() < row.updated_at.getTime())
    throw new SweepCursorError("sweep_clock_unavailable");
  return value;
}

function asLease(row: Cursor): SweepLease {
  return leaseSchema.parse({
    producer: row.producer,
    epoch: row.epoch,
    revision: row.revision,
    after_id: row.after_id,
    epoch_upper_id: row.epoch_upper_id,
    epoch_cutoff_at: row.epoch_cutoff_at,
    owner_boot_id: row.lease_owner_boot_id,
    lease_token: row.lease_token,
    lease_until: row.lease_until,
  });
}

const receiptOperations = {
  [AuditAction.SCHEDULER_SWEEP_CLAIMED]: "claim",
  [AuditAction.SCHEDULER_SWEEP_RENEWED]: "renew",
  [AuditAction.SCHEDULER_SWEEP_PROGRESSED]: "checkpoint",
  [AuditAction.SCHEDULER_SWEEP_RELEASED]: "release",
  [AuditAction.SCHEDULER_SWEEP_COMPLETED]: "complete",
} as const;

async function receipt(
  tx: Executor,
  action: keyof typeof receiptOperations,
  row: Cursor,
  counts?: { visited: number; admitted: number; skipped: number; failed: number },
  outcome?: "empty" | "complete",
) {
  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action,
      resource_type: "scheduler_sweep",
      resource_id: row.producer,
      metadata: {
        request_source: "scheduler",
        operation: receiptOperations[action],
        ...(outcome ? { outcome } : {}),
        producer: row.producer,
        epoch: row.epoch,
        revision: row.revision,
        ...(counts
          ? {
              visited: counts.visited,
              admitted: counts.admitted,
              skipped: counts.skipped,
              failed: counts.failed,
            }
          : {}),
      },
    },
    tx,
  );
}

function isLockBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "55P03") return true;
  return "cause" in error && isLockBusy(error.cause);
}

async function pageCandidates(
  tx: Executor,
  lease: SweepLease,
  limit = SWEEP_PAGE_LIMIT,
): Promise<SweepCandidate[]> {
  const result = await tx.execute<SweepCandidate>(sql`
    SELECT id, tenant_id, created_at FROM (${sweepSource(lease.producer)}) source
    WHERE created_at <= ${lease.epoch_cutoff_at} AND id <= ${lease.epoch_upper_id}::uuid
      ${lease.after_id ? sql`AND id > ${lease.after_id}::uuid` : sql``}
    ORDER BY id ASC LIMIT ${limit}`);
  const parsed = z
    .array(candidateSchema.extend({ created_at: databaseDate }))
    .max(SWEEP_PAGE_LIMIT)
    .safeParse(result.rows);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > SWEEP_METADATA_MAX_BYTES
  )
    throw new SweepCursorError("sweep_metadata_invalid");
  return parsed.data;
}

export async function acquireSweepPage(
  producer: SchedulerSweepProducer,
  ownerBootId: string,
  db: Db,
): Promise<SweepAcquireResult> {
  producerSchema.parse(producer);
  z.string().uuid().parse(ownerBootId);
  try {
    return await boundedTransaction(db, async (tx) => {
      const row = await lockCursor(tx, producer, "update");
      const clock = await databaseTime(tx, row);
      if (clock.live) return { kind: "busy" as const };
      let upper = row.epoch_upper_id;
      let cutoff = row.epoch_cutoff_at;
      let epoch = row.epoch;
      if (!upper || !cutoff) {
        cutoff = clock.at;
        epoch = increment(epoch);
        const maximum = await tx.execute<{ id: string }>(sql`
          SELECT id FROM (${sweepSource(producer)}) source
          WHERE created_at <= ${cutoff} ORDER BY id DESC LIMIT 1`);
        upper = maximum.rows[0]?.id ?? null;
      }
      const revision = increment(row.revision);
      if (!upper || !cutoff) {
        const [updated] = await tx
          .update(schedulerSweepCursors)
          .set({ epoch, revision, updated_at: clock.at })
          .where(eq(schedulerSweepCursors.producer, producer))
          .returning();
        const next = cursorSchema.parse(updated);
        await receipt(tx, AuditAction.SCHEDULER_SWEEP_COMPLETED, next, undefined, "empty");
        return { kind: "empty" as const, epoch, revision };
      }
      const [updated] = await tx
        .update(schedulerSweepCursors)
        .set({
          epoch,
          revision,
          epoch_upper_id: upper,
          epoch_cutoff_at: cutoff,
          lease_owner_boot_id: ownerBootId,
          lease_token: randomUUID(),
          lease_until: sql`${clock.at}::timestamptz + interval '60 seconds'`,
          updated_at: clock.at,
        })
        .where(eq(schedulerSweepCursors.producer, producer))
        .returning();
      const next = cursorSchema.parse(updated);
      const lease = asLease(next);
      const candidates = await pageCandidates(tx, lease);
      await receipt(tx, AuditAction.SCHEDULER_SWEEP_CLAIMED, next);
      const page = Object.freeze({
        kind: "claimed" as const,
        lease,
        candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
      });
      ownedPages.add(page);
      return page;
    });
  } catch (error) {
    if (isLockBusy(error)) return { kind: "busy" as const };
    throw error;
  }
}

export async function withLiveSweepLease<T>(
  leaseInput: SweepLease,
  db: Db,
  run: (tx: Executor, row: Cursor, at: Date) => Promise<T>,
): Promise<T | SweepLostLease> {
  const lease = leaseSchema.parse(leaseInput);
  try {
    return await boundedTransaction(db, async (tx) => {
      const row = await lockCursor(tx, lease.producer, "share", false);
      if (!sameLease(row, lease)) return lost;
      const clock = await databaseTime(tx, row);
      if (!clock.live) return lost;
      const result = await run(tx, row, clock.at);
      if (!(await databaseTime(tx, row)).live) throw new LeaseExpired();
      return result;
    });
  } catch (error) {
    if (error instanceof LeaseExpired || isLockBusy(error)) return lost;
    throw error;
  }
}

class LeaseExpired extends Error {}

export async function recheckSweepCandidate(
  lease: SweepLease,
  candidateInput: SweepCandidate,
  db: Db,
): Promise<
  { kind: "eligible_metadata"; candidate: SweepCandidate } | { kind: "ineligible" } | SweepLostLease
> {
  const candidate = candidateSchema.parse(candidateInput);
  return withLiveSweepLease(lease, db, async (tx) => {
    const rows = await pageCandidates(tx, lease);
    const current = rows.find(
      (row) =>
        row.id === candidate.id &&
        row.tenant_id === candidate.tenant_id &&
        row.created_at.getTime() === candidate.created_at.getTime(),
    );
    return current
      ? { kind: "eligible_metadata" as const, candidate: current }
      : { kind: "ineligible" as const };
  });
}

async function mutateLease(
  leaseInput: SweepLease,
  db: Db,
  operation: "renew" | "release" | "complete" | "checkpoint",
  progress?: { last: string; visited: number; admitted: number; skipped: number; failed: number },
): Promise<
  | { kind: "updated"; lease: SweepLease }
  | { kind: "released" }
  | { kind: "completed" }
  | { kind: "not_exhausted" }
  | SweepLostLease
> {
  const lease = leaseSchema.parse(leaseInput);
  try {
    return await boundedTransaction(db, async (tx) => {
      const row = await lockCursor(tx, lease.producer, "update");
      if (!sameLease(row, lease)) return lost;
      const clock = await databaseTime(tx, row);
      if (!clock.live) return lost;
      if (operation === "complete" && (await pageCandidates(tx, lease, 1)).length > 0)
        return { kind: "not_exhausted" as const };
      const revision = increment(row.revision);
      const clear = operation === "complete";
      const release = operation === "release" || clear;
      const [updated] = await tx
        .update(schedulerSweepCursors)
        .set({
          revision,
          updated_at: clock.at,
          ...(progress ? { after_id: progress.last } : {}),
          ...(operation === "renew"
            ? { lease_until: sql`${clock.at}::timestamptz + interval '60 seconds'` }
            : {}),
          ...(release ? { lease_owner_boot_id: null, lease_token: null, lease_until: null } : {}),
          ...(clear ? { after_id: null, epoch_upper_id: null, epoch_cutoff_at: null } : {}),
        })
        .where(eq(schedulerSweepCursors.producer, lease.producer))
        .returning();
      const next = cursorSchema.parse(updated);
      const action = progress
        ? AuditAction.SCHEDULER_SWEEP_PROGRESSED
        : operation === "renew"
          ? AuditAction.SCHEDULER_SWEEP_RENEWED
          : operation === "release"
            ? AuditAction.SCHEDULER_SWEEP_RELEASED
            : AuditAction.SCHEDULER_SWEEP_COMPLETED;
      await receipt(tx, action, next, progress, operation === "complete" ? "complete" : undefined);
      if (!(await databaseTime(tx, row)).live) throw new LeaseExpired();
      if (operation === "complete") return { kind: "completed" as const };
      if (operation === "release") return { kind: "released" as const };
      return { kind: "updated" as const, lease: asLease(next) };
    });
  } catch (error) {
    if (error instanceof LeaseExpired || isLockBusy(error)) return lost;
    throw error;
  }
}

export async function renewSweepLease(lease: SweepLease, db: Db) {
  const result = await mutateLease(lease, db, "renew");
  return result.kind === "updated" ? { kind: "renewed" as const, lease: result.lease } : lost;
}
export async function releaseSweepLease(lease: SweepLease, db: Db) {
  const result = await mutateLease(lease, db, "release");
  return result.kind === "released" ? result : lost;
}
export async function completeSweepEpoch(lease: SweepLease, db: Db) {
  const result = await mutateLease(lease, db, "complete");
  return result.kind === "completed" || result.kind === "not_exhausted" ? result : lost;
}

export async function walkSweepPage(
  page: SweepPage,
  db: Db,
  visit: (
    candidate: SweepCandidate,
    lease: SweepLease,
  ) => Promise<"visited" | "deferred" | "admitted">,
) {
  if (!ownedPages.delete(page)) throw new SweepCursorError("sweep_page_unowned");
  const started = performance.now();
  let last: string | null = null;
  let admitted = 0;
  let skipped = 0;
  let failed = 0;
  let visited = 0;
  for (const candidate of page.candidates) {
    if (performance.now() - started >= SWEEP_VISIT_WINDOW_MS) break;
    const checked = await recheckSweepCandidate(page.lease, candidate, db);
    if (checked.kind === "lost_lease") return checked;
    if (checked.kind === "ineligible") {
      skipped++;
    } else {
      try {
        const outcome = await visit(checked.candidate, page.lease);
        if (outcome === "deferred") break;
        if (outcome === "admitted") admitted++;
        else skipped++;
      } catch {
        failed++;
      }
    }
    visited++;
    last = candidate.id;
  }
  if (!last)
    return { kind: "walked" as const, lease: page.lease, visited, admitted, skipped, failed };
  const updated = await mutateLease(page.lease, db, "checkpoint", {
    last,
    visited,
    admitted,
    skipped,
    failed,
  });
  if (updated.kind !== "updated") return lost;
  return { kind: "walked" as const, lease: updated.lease, visited, admitted, skipped, failed };
}
