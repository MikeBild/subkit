import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { AppBudgetToday } from "../api/app-schemas.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { auditLog, callerBudgetUnits, executions, workflowVersions } from "../db/schema/index.ts";
import { type ErasureFollowUp, eraseProductCaller } from "../identity/product-erasure.ts";
import { logger } from "../logging/logger.ts";
import { executableDefinition } from "../workflows/stored-definition.ts";
import type { CallerDailyLimit, WorkflowDef } from "../workflows/types.ts";
import { type CallerContext, CallerContextSchema } from "./caller-context.ts";
import { evaluate as evaluateJsonata } from "./jsonata-engine.ts";
import type { ExecutionStatus } from "./types.ts";

const ACTIVE_STATUSES: ExecutionStatus[] = ["queued", "running"];
const UNIT_KEY_MAX = 128;

export interface CallerUsage {
  usedToday: number;
  dailyLimit: number;
  day: string;
  resetsAt: string;
}

interface CallerBudgetLedger {
  tenant_id: string;
  bucket: string;
  principal_id: string;
  limit: number;
  tz: string;
}

interface CallerBudgetReservation {
  bucket: string;
  unit_key: string;
  execution_guard_key: string;
  principal_id: string;
  charged: boolean;
}

export type CallerBudgetRefusalCode = "rate_limited" | "turn_busy" | "turn_limit" | "invalid";

function refuse(code: CallerBudgetRefusalCode, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function executionGuardKey(principalId: string, unitKey: string): string {
  return `${principalId}/${unitKey}`;
}

function valueAt(input: unknown, path: string): unknown {
  let current = input;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function assertInputByteLimits(def: WorkflowDef, input: unknown): void {
  for (const [path, max] of Object.entries(def.execution_guards?.input_bytes ?? {})) {
    const value = valueAt(input, path);
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > max)
      refuse("invalid", `input ${path} exceeds ${max} bytes`);
  }
}

async function lockLedger(tx: Executor, ledger: Omit<CallerBudgetLedger, "limit" | "tz">) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ledger.tenant_id}:${ledger.bucket}:${ledger.principal_id}:budget`}, 0))`,
  );
}

async function localDay(
  tx: Executor,
  tz: string,
  now: Date,
): Promise<{ day: string; resetsAt: string }> {
  const at = now.toISOString();
  const result = await tx.execute<{ day: string; resets_at: string }>(
    sql`SELECT ((${at}::timestamptz AT TIME ZONE ${tz})::date)::text AS day,
      to_char(((date_trunc('day', ${at}::timestamptz AT TIME ZONE ${tz}) + interval '1 day') AT TIME ZONE ${tz}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resets_at`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("local day unavailable");
  return { day: row.day, resetsAt: row.resets_at };
}

interface LocalDayWindow {
  day: string;
  startsAt: string;
  resetsAt: string;
}

async function localDayWindow(
  tx: Executor,
  tz: string,
  now: Date = new Date(),
): Promise<LocalDayWindow> {
  const at = now.toISOString();
  const { day, resetsAt } = await localDay(tx, tz, now);
  const result = await tx.execute<{ starts_at: string }>(
    sql`SELECT to_char((date_trunc('day', ${at}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS starts_at`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("local day unavailable");
  return { day, startsAt: row.starts_at, resetsAt };
}

const BUDGET_REFUSAL_REASONS = ["rate_limited", "turn_limit", "turn_busy"] as const;

export async function bucketUsageToday(
  tx: Executor,
  input: {
    tenant_id: string;
    product_id: string;
    bucket: string;
    tz: string;
    workflow_ids: string[];
  },
  now: Date = new Date(),
): Promise<AppBudgetToday> {
  const window = await localDayWindow(tx, input.tz, now);
  const [units] = await tx
    .select({
      consumed: sql<number>`count(*) FILTER (WHERE ${callerBudgetUnits.state} = 'committed')::int`,
      reserved: sql<number>`count(*) FILTER (WHERE ${callerBudgetUnits.state} = 'reserved')::int`,
    })
    .from(callerBudgetUnits)
    .where(
      and(
        eq(callerBudgetUnits.tenant_id, input.tenant_id),
        eq(callerBudgetUnits.product_id, input.product_id),
        eq(callerBudgetUnits.bucket, input.bucket),
        eq(callerBudgetUnits.day, window.day),
      ),
    );
  let refusals = 0;
  if (input.workflow_ids.length > 0) {
    const [row] = await tx
      .select({ refusals: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, input.tenant_id),
          eq(auditLog.action, AuditAction.EXECUTION_BOUNDARY_REFUSED),
          inArray(auditLog.reason, [...BUDGET_REFUSAL_REASONS]),
          inArray(sql<string>`${auditLog.metadata}->>'workflow_id'`, input.workflow_ids),
          sql`${auditLog.ts} >= ${window.startsAt}::timestamptz`,
        ),
      );
    refusals = row?.refusals ?? 0;
  }
  return {
    bucket: input.bucket,
    day: window.day,
    tz: input.tz,
    resets_at: window.resetsAt,
    consumed: units?.consumed ?? 0,
    reserved: units?.reserved ?? 0,
    refusals_today: refusals,
  };
}

async function settleExpiredLeases(
  tx: Executor,
  ledger: Omit<CallerBudgetLedger, "limit" | "tz">,
  now: Date,
): Promise<void> {
  await tx
    .update(callerBudgetUnits)
    .set({
      state: sql`CASE WHEN ${callerBudgetUnits.billable} THEN 'committed' ELSE 'refunded' END`,
      updated_at: now,
    })
    .where(
      and(
        eq(callerBudgetUnits.tenant_id, ledger.tenant_id),
        eq(callerBudgetUnits.bucket, ledger.bucket),
        eq(callerBudgetUnits.principal_id, ledger.principal_id),
        eq(callerBudgetUnits.state, "reserved"),
        sql`${callerBudgetUnits.lease_until} < ${now.toISOString()}::timestamptz`,
        sql`NOT EXISTS (SELECT 1 FROM ${executions} WHERE ${executions.tenant_id} = ${ledger.tenant_id} AND ${executions.guard_unit_key} = ${ledger.principal_id}::text || '/' || ${callerBudgetUnits.unit_key} AND ${executions.status} IN ('queued', 'running'))`,
      ),
    );
}

async function usedOn(
  tx: Executor,
  ledger: Omit<CallerBudgetLedger, "limit" | "tz">,
  day: string,
): Promise<number> {
  const [row] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(callerBudgetUnits)
    .where(
      and(
        eq(callerBudgetUnits.tenant_id, ledger.tenant_id),
        eq(callerBudgetUnits.bucket, ledger.bucket),
        eq(callerBudgetUnits.principal_id, ledger.principal_id),
        eq(callerBudgetUnits.day, day),
        inArray(callerBudgetUnits.state, ["reserved", "committed"]),
      ),
    );
  return row?.used ?? 0;
}

export async function callerUsage(
  tx: Executor,
  ledger: CallerBudgetLedger,
  now: Date = new Date(),
): Promise<CallerUsage> {
  await lockLedger(tx, ledger);
  await settleExpiredLeases(tx, ledger, now);
  const { day, resetsAt } = await localDay(tx, ledger.tz, now);
  return { usedToday: await usedOn(tx, ledger, day), dailyLimit: ledger.limit, day, resetsAt };
}

async function hasActiveExecution(
  tx: Executor,
  tenant_id: string,
  guard_unit_key: string,
): Promise<boolean> {
  const [active] = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.guard_unit_key, guard_unit_key),
        inArray(executions.status, ACTIVE_STATUSES),
        isNull(executions.abort_requested_at),
      ),
    )
    .limit(1);
  return active !== undefined;
}

function unitKeyOf(guard: CallerDailyLimit, input: unknown): string {
  const value = valueAt(input, guard.unit);
  const key = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof key !== "string" || key.length < 1 || key.length > UNIT_KEY_MAX)
    refuse("invalid", "the budget unit must be a string of 1..128 characters");
  return key;
}

function productCaller(caller: CallerContext | null): CallerContext & { productId: string } {
  if (!caller || caller.principalKind !== "user" || !caller.productId)
    throw Object.assign(new Error("a caller budget needs a product user caller"), {
      code: "caller_required",
    });
  return caller as CallerContext & { productId: string };
}

export async function reserveCallerBudget(
  tx: Executor,
  def: WorkflowDef,
  caller: CallerContext | null,
  input: unknown,
  now: Date = new Date(),
): Promise<CallerBudgetReservation | null> {
  assertInputByteLimits(def, input);
  if (def.caller_erasure && !caller?.subject)
    throw Object.assign(new Error("caller erasure needs a caller verified by a bearer provider"), {
      code: "caller_required",
    });
  const guard = def.execution_guards?.caller_daily_limit;
  if (!guard) return null;
  const owner = productCaller(caller);
  const unit_key = unitKeyOf(guard, input);
  const ledger = {
    tenant_id: owner.tenantId,
    bucket: guard.bucket,
    principal_id: owner.principalId,
    limit: guard.limit,
    tz: guard.tz,
  };
  await lockLedger(tx, ledger);
  await settleExpiredLeases(tx, ledger, now);
  const leaseUntil = new Date(now.getTime() + guard.lease_ms);
  const [unit] = await tx
    .select()
    .from(callerBudgetUnits)
    .where(
      and(
        eq(callerBudgetUnits.tenant_id, ledger.tenant_id),
        eq(callerBudgetUnits.bucket, ledger.bucket),
        eq(callerBudgetUnits.principal_id, ledger.principal_id),
        eq(callerBudgetUnits.unit_key, unit_key),
      ),
    )
    .limit(1);
  const reservation = {
    bucket: guard.bucket,
    unit_key,
    execution_guard_key: executionGuardKey(owner.principalId, unit_key),
    principal_id: owner.principalId,
  };
  const open = unit?.state === "reserved" || unit?.state === "committed";
  if (await hasActiveExecution(tx, ledger.tenant_id, reservation.execution_guard_key))
    refuse("turn_busy", "this turn already has a call in progress");
  if (open && unit.metered >= guard.max_metered)
    refuse("turn_limit", "this turn has used all of its metered calls");
  if (unit?.state === "committed") return { ...reservation, charged: false };
  if (unit?.state === "reserved") {
    await tx
      .update(callerBudgetUnits)
      .set({ lease_until: leaseUntil, updated_at: now })
      .where(
        and(
          eq(callerBudgetUnits.tenant_id, ledger.tenant_id),
          eq(callerBudgetUnits.bucket, ledger.bucket),
          eq(callerBudgetUnits.principal_id, ledger.principal_id),
          eq(callerBudgetUnits.unit_key, unit_key),
        ),
      );
    return { ...reservation, charged: false };
  }
  const { day, resetsAt } = await localDay(tx, guard.tz, now);
  const usedToday = await usedOn(tx, ledger, day);
  if (usedToday >= guard.limit)
    refuse("rate_limited", "the daily limit is reached", {
      usage: { usedToday, dailyLimit: guard.limit, day, resetsAt },
    });
  await tx
    .insert(callerBudgetUnits)
    .values({
      tenant_id: ledger.tenant_id,
      product_id: owner.productId,
      bucket: ledger.bucket,
      principal_id: ledger.principal_id,
      unit_key,
      day,
      state: "reserved",
      lease_until: leaseUntil,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        callerBudgetUnits.tenant_id,
        callerBudgetUnits.bucket,
        callerBudgetUnits.principal_id,
        callerBudgetUnits.unit_key,
      ],
      set: { state: "reserved", day, lease_until: leaseUntil, updated_at: now },
    });
  return { ...reservation, charged: true };
}

export async function bindCallerBudget(
  tx: Executor,
  tenant_id: string,
  execution_id: string,
  reservation: CallerBudgetReservation | null,
): Promise<void> {
  if (!reservation) return;
  await tx
    .update(executions)
    .set({ guard_bucket: reservation.bucket, guard_unit_key: reservation.execution_guard_key })
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)));
  if (!reservation.charged) return;
  await tx
    .update(callerBudgetUnits)
    .set({ charged_execution_id: execution_id })
    .where(
      and(
        eq(callerBudgetUnits.tenant_id, tenant_id),
        eq(callerBudgetUnits.bucket, reservation.bucket),
        eq(callerBudgetUnits.principal_id, reservation.principal_id),
        eq(callerBudgetUnits.unit_key, reservation.unit_key),
      ),
    );
}

interface GuardedExecution {
  workflow_version_id: string | null;
  guard_bucket: string | null;
  guard_unit_key: string | null;
  caller_context: unknown;
}

async function guardedDefinition(
  tx: Executor,
  tenant_id: string,
  row: GuardedExecution,
): Promise<WorkflowDef | null> {
  if (!row.workflow_version_id) return null;
  const [version] = await tx
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.id, row.workflow_version_id),
      ),
    )
    .limit(1);
  return version ? executableDefinition(version.dag) : null;
}

function unitOf(row: GuardedExecution, caller: CallerContext) {
  const prefix = `${caller.principalId}/`;
  if (!row.guard_bucket || !row.guard_unit_key?.startsWith(prefix)) return null;
  return {
    bucket: row.guard_bucket,
    unit_key: row.guard_unit_key.slice(prefix.length),
    principal_id: caller.principalId,
  };
}

function unitWhere(tenant_id: string, unit: NonNullable<ReturnType<typeof unitOf>>) {
  return and(
    eq(callerBudgetUnits.tenant_id, tenant_id),
    eq(callerBudgetUnits.bucket, unit.bucket),
    eq(callerBudgetUnits.principal_id, unit.principal_id),
    eq(callerBudgetUnits.unit_key, unit.unit_key),
  );
}

const billableDispatches = new Map<string, number>();

export function takeBillableDispatches(step_row_id: string): number {
  const count = billableDispatches.get(step_row_id) ?? 0;
  billableDispatches.delete(step_row_id);
  return count;
}

async function meterOf(guard: CallerDailyLimit, output: unknown): Promise<number> {
  if (!guard.meter) return 1;
  try {
    const value = await evaluateJsonata(guard.meter, output ?? null, {});
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 1;
  } catch {
    return 1;
  }
}

async function guardedUnit(
  tx: Executor,
  tenant_id: string,
  step_key: string,
  row: GuardedExecution,
) {
  if (!row.guard_unit_key) return null;
  const caller = CallerContextSchema.safeParse(row.caller_context);
  if (!caller.success) return null;
  const unit = unitOf(row, caller.data);
  if (!unit) return null;
  const def = await guardedDefinition(tx, tenant_id, row);
  const guard = def?.execution_guards?.caller_daily_limit;
  if (!guard?.billable_steps.includes(step_key)) return null;
  return { unit, guard };
}

export async function markBillableDispatch(
  db: Db,
  params: { tenant_id: string; execution_id: string; step_key: string; step_row_id?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        workflow_version_id: executions.workflow_version_id,
        guard_bucket: executions.guard_bucket,
        guard_unit_key: executions.guard_unit_key,
        caller_context: executions.caller_context,
      })
      .from(executions)
      .where(
        and(eq(executions.tenant_id, params.tenant_id), eq(executions.id, params.execution_id)),
      )
      .limit(1);
    if (!row) return;
    const guarded = await guardedUnit(tx, params.tenant_id, params.step_key, row);
    if (!guarded) return;
    await lockLedger(tx, { tenant_id: params.tenant_id, ...guarded.unit });
    await tx
      .update(callerBudgetUnits)
      .set({
        billable: true,
        metered: sql`${callerBudgetUnits.metered} + 1`,
        updated_at: new Date(),
      })
      .where(unitWhere(params.tenant_id, guarded.unit));
  });
  if (params.step_row_id)
    billableDispatches.set(
      params.step_row_id,
      (billableDispatches.get(params.step_row_id) ?? 0) + 1,
    );
}

export async function markBillableStep(
  tx: Executor,
  params: {
    tenant_id: string;
    execution_id: string;
    step_key: string;
    output: unknown;
    row: GuardedExecution;
    dispatched: number;
  },
): Promise<void> {
  const guarded = await guardedUnit(tx, params.tenant_id, params.step_key, params.row);
  if (!guarded) return;
  const extra = Math.max((await meterOf(guarded.guard, params.output)) - params.dispatched, 0);
  await tx
    .update(callerBudgetUnits)
    .set({
      billable: true,
      metered: sql`${callerBudgetUnits.metered} + ${extra}`,
      updated_at: new Date(),
    })
    .where(unitWhere(params.tenant_id, guarded.unit));
}

interface GuardSettlement {
  attach?: { key: string; usage: { usedToday: number; dailyLimit: number } };
  after_commit?: ErasureFollowUp;
}

export async function settleExecutionGuards(
  tx: Executor,
  params: {
    tenant_id: string;
    execution_id: string;
    status: ExecutionStatus;
    output: unknown;
    now?: Date;
  },
): Promise<GuardSettlement> {
  const now = params.now ?? new Date();
  const [row] = await tx
    .select({
      workflow_version_id: executions.workflow_version_id,
      guard_bucket: executions.guard_bucket,
      guard_unit_key: executions.guard_unit_key,
      caller_context: executions.caller_context,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, params.tenant_id), eq(executions.id, params.execution_id)))
    .limit(1);
  const caller = CallerContextSchema.safeParse(row?.caller_context);
  if (!row || !caller.success || !caller.data.productId) return {};
  if (!row.guard_unit_key && !caller.data.subject) return {};
  const def = await guardedDefinition(tx, params.tenant_id, row);
  if (!def) return {};
  const settlement: GuardSettlement = {};
  const guard = def.execution_guards?.caller_daily_limit;
  const unit = unitOf(row, caller.data);
  if (guard && unit) {
    const ledger = { tenant_id: params.tenant_id, ...unit, limit: guard.limit, tz: guard.tz };
    await lockLedger(tx, ledger);
    const [current] = await tx
      .select()
      .from(callerBudgetUnits)
      .where(unitWhere(params.tenant_id, unit))
      .limit(1);
    if (current?.state === "reserved") {
      if (params.status === "succeeded") {
        let commit = false;
        try {
          commit = (await evaluateJsonata(guard.commit_when, params.output ?? null, {})) === true;
        } catch (error) {
          logger.warn({
            module: "execution",
            action: "caller_budget.commit_when_failed",
            execution_id: params.execution_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await tx
          .update(callerBudgetUnits)
          .set(
            commit
              ? { state: "committed", updated_at: now }
              : { lease_until: new Date(now.getTime() + guard.lease_ms), updated_at: now },
          )
          .where(unitWhere(params.tenant_id, unit));
      } else if (!current.billable) {
        const [sibling] = await tx
          .select({ id: executions.id })
          .from(executions)
          .where(
            and(
              eq(executions.tenant_id, params.tenant_id),
              eq(executions.guard_unit_key, executionGuardKey(unit.principal_id, unit.unit_key)),
              inArray(executions.status, ACTIVE_STATUSES),
              ne(executions.id, params.execution_id),
            ),
          )
          .limit(1);
        if (!sibling)
          await tx
            .update(callerBudgetUnits)
            .set({ state: "refunded", updated_at: now })
            .where(unitWhere(params.tenant_id, unit));
      }
    }
    if (params.status === "succeeded") {
      const usage = await callerUsage(tx, ledger, now);
      settlement.attach = {
        key: guard.attach_usage_as,
        usage: { usedToday: usage.usedToday, dailyLimit: usage.dailyLimit },
      };
    }
  }
  if (params.status === "succeeded" && def.caller_erasure === "on_success") {
    settlement.after_commit = await eraseProductCaller(tx, caller.data, {
      kind: "workflow",
      execution_id: params.execution_id,
      now,
    });
  }
  return settlement;
}
