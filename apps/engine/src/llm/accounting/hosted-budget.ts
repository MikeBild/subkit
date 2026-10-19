import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { hostedBudgetReservations, tenants } from "../../db/schema/index.ts";
import { now } from "../../utils/clock.ts";
import { LlmQuotaExhausted } from "../errors.ts";

const reservationInput = z
  .object({
    tenant_id: z.uuid(),
    request_key: z
      .string()
      .min(1)
      .max(200)
      .transform((key) => createHash("sha256").update(key).digest("hex")),
    model: z.string().regex(/^[a-zA-Z0-9._:@/+-]{1,200}$/),
    currency: z.literal("USD"),
    reserved_microunits: z.bigint().positive(),
    tenant_limit_microunits: z.bigint().positive(),
    global_limit_microunits: z.bigint().positive(),
  })
  .strict();

export type HostedBudgetReservationInput = z.input<typeof reservationInput>;

function monthBucket(): string {
  const current = new Date(now());
  return `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function lockMonth(tx: Executor, month: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-budget:${month}`}, 0))`,
  );
}

function quota(reason: string): LlmQuotaExhausted {
  return new LlmQuotaExhausted("Hosted money budget cannot admit this provider call", { reason });
}

export async function reserveHostedBudget(raw: HostedBudgetReservationInput, exec?: Executor) {
  const input = reservationInput.parse(raw);
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const month = monthBucket();
    await lockMonth(tx, month);
    const [tenant] = await tx
      .select({ origin: tenants.origin, status: tenants.status, deleted_at: tenants.deleted_at })
      .from(tenants)
      .where(eq(tenants.id, input.tenant_id))
      .limit(1);
    if (
      tenant?.origin !== "self_service" ||
      tenant.status !== "active" ||
      tenant.deleted_at !== null
    ) {
      throw quota("tenant_unavailable");
    }
    const [existing] = await tx
      .select()
      .from(hostedBudgetReservations)
      .where(
        and(
          eq(hostedBudgetReservations.tenant_id, input.tenant_id),
          eq(hostedBudgetReservations.request_key, input.request_key),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.model !== input.model ||
        existing.currency !== input.currency ||
        existing.reserved_microunits !== input.reserved_microunits
      ) {
        throw quota("reservation_conflict");
      }
      return { reservation: existing, created: false };
    }
    // tenant-filter:exempt — operator-owned global money ceiling must atomically include reservations from every hosted tenant.
    const [usage] = await tx
      .select({
        global_used: sql<string>`coalesce(sum(CASE WHEN ${hostedBudgetReservations.state} = 'released' THEN 0 WHEN ${hostedBudgetReservations.state} = 'settled' THEN ${hostedBudgetReservations.reported_microunits} ELSE greatest(${hostedBudgetReservations.reserved_microunits}, coalesce(${hostedBudgetReservations.reported_microunits}, 0)) END), 0)::text`,
        tenant_used: sql<string>`coalesce(sum(CASE WHEN ${hostedBudgetReservations.tenant_id} <> ${input.tenant_id} OR ${hostedBudgetReservations.state} = 'released' THEN 0 WHEN ${hostedBudgetReservations.state} = 'settled' THEN ${hostedBudgetReservations.reported_microunits} ELSE greatest(${hostedBudgetReservations.reserved_microunits}, coalesce(${hostedBudgetReservations.reported_microunits}, 0)) END), 0)::text`,
        unresolved: sql<number>`count(*) FILTER (WHERE ${hostedBudgetReservations.state} = 'reconciliation_required')::int`,
      })
      .from(hostedBudgetReservations)
      .where(eq(hostedBudgetReservations.month_bucket, month));
    if ((usage?.unresolved ?? 0) > 0) throw quota("reconciliation_required");
    if (
      BigInt(usage?.tenant_used ?? "0") + input.reserved_microunits >
      input.tenant_limit_microunits
    )
      throw quota("tenant_monthly_limit");
    if (
      BigInt(usage?.global_used ?? "0") + input.reserved_microunits >
      input.global_limit_microunits
    )
      throw quota("global_monthly_limit");
    const [reservation] = await tx
      .insert(hostedBudgetReservations)
      .values({
        tenant_id: input.tenant_id,
        request_key: input.request_key,
        month_bucket: month,
        currency: input.currency,
        model: input.model,
        reserved_microunits: input.reserved_microunits,
        state: "reserved",
      })
      .returning();
    assertInsertRow(reservation, "hosted_budget_reservations");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.LLM_BUDGET_RESERVED,
        resource_type: "llm_budget",
        resource_id: reservation.id,
        result: "success",
        metadata: {
          currency: reservation.currency,
          reserved_microunits: String(reservation.reserved_microunits),
          model: reservation.model,
        },
      },
      tx,
    );
    return { reservation, created: true };
  });
}

export async function settleHostedBudget(
  tenantId: string,
  reservationId: string,
  reportedMicrounits: bigint,
  exec?: Executor,
) {
  z.bigint().nonnegative().parse(reportedMicrounits);
  const db = exec ?? getDb();
  const outcome = await db.transaction(async (tx) => {
    const tenantWhere = and(
      eq(hostedBudgetReservations.tenant_id, tenantId),
      eq(hostedBudgetReservations.id, reservationId),
    );
    const [known] = await tx.select().from(hostedBudgetReservations).where(tenantWhere).limit(1);
    if (!known) throw quota("reservation_not_found");
    await lockMonth(tx, known.month_bucket);
    const [current] = await tx
      .select()
      .from(hostedBudgetReservations)
      .where(tenantWhere)
      .for("update");
    if (!current) throw quota("reservation_not_found");
    if (current.state !== "reserved") {
      if (current.state === "settled" && current.reported_microunits === reportedMicrounits)
        return current;
      throw quota("settlement_conflict");
    }
    const [settled] = await tx
      .update(hostedBudgetReservations)
      .set({
        reported_microunits: reportedMicrounits,
        state:
          reportedMicrounits <= current.reserved_microunits ? "settled" : "reconciliation_required",
        updated_at: new Date(now()),
      })
      .where(tenantWhere)
      .returning();
    assertInsertRow(settled, "hosted_budget_reservations");
    await auditAwait(
      {
        tenant_id: tenantId,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.LLM_BUDGET_SETTLED,
        resource_type: "llm_budget",
        resource_id: reservationId,
        result: settled.state === "settled" ? "success" : "error",
        metadata: {
          currency: settled.currency,
          reported_microunits: String(reportedMicrounits),
          state: settled.state,
        },
      },
      tx,
    );
    return settled;
  });
  if (outcome.state === "reconciliation_required") throw quota("reservation_overrun");
  return outcome;
}
