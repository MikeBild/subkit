import { sql } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { type SweepCandidate, type SweepLease, withLiveSweepLease } from "./sweep-cursor.ts";
import {
  SWEEP_CADENCE_MS,
  type SweepCadenceProducer,
  sweepCadenceColumn,
  sweepSource,
} from "./sweep-cursor-source.ts";

const cadenceSchema = z.enum(["drift", "reauth", "endpoint-contract", "skill", "notes"]);
const expectationSchema = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/)
  .nullable();
const candidateSchema = z
  .object({ id: z.string().uuid(), tenant_id: z.string().uuid(), created_at: z.date() })
  .strict();

export async function readSweepCadenceCandidate(
  lease: SweepLease & { producer: SweepCadenceProducer },
  candidateInput: SweepCandidate,
  db: Db,
) {
  const producer = cadenceSchema.parse(lease.producer);
  const candidate = candidateSchema.parse(candidateInput);
  return withLiveSweepLease(lease, db, async (tx) => {
    const column = sweepCadenceColumn(producer);
    const result = await tx.execute<{ expected_at: string | null }>(sql`
      SELECT ${column}::text AS expected_at FROM ${tenants}
      WHERE id = ${candidate.id}::uuid AND id = ${candidate.tenant_id}::uuid
        AND status = 'active' AND deleted_at IS NULL
        AND created_at <= ${lease.epoch_cutoff_at} AND id <= ${lease.epoch_upper_id}::uuid
        ${lease.after_id ? sql`AND id > ${lease.after_id}::uuid` : sql``}
      LIMIT 1`);
    const row = result.rows[0];
    return row
      ? { kind: "cadence_metadata" as const, expected_at: expectationSchema.parse(row.expected_at) }
      : { kind: "ineligible" as const };
  });
}

export async function claimSweepCadenceCandidate(
  lease: SweepLease & { producer: SweepCadenceProducer },
  candidateInput: SweepCandidate,
  expectedAt: string | null,
  db: Db,
  observedAt?: Date,
) {
  const producer = cadenceSchema.parse(lease.producer);
  const candidate = candidateSchema.parse(candidateInput);
  const expected = expectationSchema.parse(expectedAt);
  return withLiveSweepLease(lease, db, async (tx, row, at) => {
    const eligible = await tx.execute<{ id: string }>(sql`
      SELECT id FROM (${sweepSource(producer)}) source
      WHERE id = ${candidate.id}::uuid AND tenant_id = ${candidate.tenant_id}::uuid
        AND created_at <= ${lease.epoch_cutoff_at} AND id <= ${lease.epoch_upper_id}::uuid
        ${lease.after_id ? sql`AND id > ${lease.after_id}::uuid` : sql``}`);
    if (eligible.rows.length !== 1 || candidate.id !== candidate.tenant_id)
      return { kind: "ineligible" as const };
    const column = sweepCadenceColumn(producer);
    const claimedAt = observedAt === undefined ? at : z.date().parse(observedAt);
    const cutoff = new Date(claimedAt.getTime() - SWEEP_CADENCE_MS[producer]);
    const claimed = await tx.execute<{ id: string }>(sql`
      UPDATE ${tenants} SET ${sql.identifier(column.name)} = ${claimedAt}
      WHERE id = ${candidate.id}::uuid AND id = ${candidate.tenant_id}::uuid
        AND status = 'active' AND deleted_at IS NULL
        AND ${column} IS NOT DISTINCT FROM ${expected}::timestamptz
        AND (${column} IS NULL OR ${column} < ${cutoff})
      RETURNING id`);
    if (claimed.rows.length !== 1) return { kind: "ineligible" as const };
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SCHEDULER_SWEEP_CADENCE_CLAIMED,
        resource_type: "scheduler_sweep",
        resource_id: producer,
        metadata: {
          request_source: "scheduler",
          operation: "cadence_claim",
          producer,
          epoch: row.epoch,
          revision: row.revision,
          admitted: 1,
        },
      },
      tx,
    );
    return { kind: "claimed" as const, previous_at: expected, claimed_at: claimedAt };
  });
}
