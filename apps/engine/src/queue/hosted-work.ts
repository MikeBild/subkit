import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss, SendOptions } from "pg-boss";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { getConfig } from "../config/loader.ts";
import type { Db, Executor } from "../db/client.ts";
import { hostedWorkAdmissions, tenants } from "../db/schema/index.ts";
import { tenantWorkSnapshot } from "../execution/tenant-work.ts";
import { queuedSendTransaction } from "./transaction-adapter.ts";

export type HostedWorkKind = "execution" | "chat";
interface WorkScope {
  id: string;
  pending: Set<Promise<unknown>>;
}
const context = new AsyncLocalStorage<ReadonlyMap<string, WorkScope>>();
const running = new Set<string>();
const unsettled = ["pending", "active", "reconciliation_required"] as const;

export class HostedWorkQuotaError extends Error {
  readonly code = "hosted_work_quota_exhausted";
  constructor(message: string) {
    super(message);
    this.name = "HostedWorkQuotaError";
  }
}

async function hostedTenant(exec: Executor, tenantId: string, locked = false): Promise<boolean> {
  const query = exec.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [tenant] = await (locked ? query.for("share") : query);
  if (tenant?.origin !== "self_service") return false;
  if (tenant.status !== "active" || tenant.deleted_at !== null)
    throw new HostedWorkQuotaError("Hosted workspace is unavailable");
  return true;
}

async function lockTenant(exec: Executor, tenantId: string): Promise<void> {
  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-work:${tenantId}`}, 0))`,
  );
}

function policy() {
  const limits = getConfig().queue.hosted;
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new HostedWorkQuotaError("Operator hosted work quotas are not configured");
  return limits;
}

async function record(
  exec: Executor,
  tenantId: string,
  id: string,
  action:
    | typeof AuditAction.HOSTED_WORK_ADMITTED
    | typeof AuditAction.HOSTED_WORK_STARTED
    | typeof AuditAction.HOSTED_WORK_FINISHED
    | typeof AuditAction.HOSTED_WORK_RECONCILED,
  reason: string,
) {
  await auditAwait(
    {
      tenant_id: tenantId,
      action,
      actor_type: "system",
      resource_type: "hosted_work",
      resource_id: id,
      result: "success",
      reason,
    },
    exec,
  );
}

export async function listUnsettledHostedWork(tenantId: string, exec: Executor) {
  return exec
    .select()
    .from(hostedWorkAdmissions)
    .where(
      and(
        eq(hostedWorkAdmissions.tenant_id, tenantId),
        inArray(hostedWorkAdmissions.state, [...unsettled]),
      ),
    );
}

export async function enqueueHostedWork<T extends { tenant_id: string }>(
  db: Db,
  boss: PgBoss,
  kind: HostedWorkKind,
  queueName: string,
  payload: T,
  options: SendOptions = {},
): Promise<string | null> {
  if (!(await hostedTenant(db, payload.tenant_id))) return boss.send(queueName, payload, options);
  const limits = policy();
  const jobId = options.id ?? randomUUID();
  return db.transaction(async (tx) => {
    await lockTenant(tx, payload.tenant_id);
    await hostedTenant(tx, payload.tenant_id, true);
    const [existing] = await tx
      .select()
      .from(hostedWorkAdmissions)
      .where(
        and(
          eq(hostedWorkAdmissions.tenant_id, payload.tenant_id),
          eq(hostedWorkAdmissions.queue_name, queueName),
          eq(hostedWorkAdmissions.job_id, jobId),
        ),
      )
      .limit(1);
    if (existing) return jobId;
    await releaseStoppedPendingHostedWork(payload.tenant_id, boss, tx);
    const [count] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(hostedWorkAdmissions)
      .where(
        and(
          eq(hostedWorkAdmissions.tenant_id, payload.tenant_id),
          eq(hostedWorkAdmissions.state, "pending"),
        ),
      );
    if ((count?.count ?? 0) >= limits.pending_jobs)
      throw new HostedWorkQuotaError("Hosted workspace pending-job quota is exhausted");
    const [row] = await tx
      .insert(hostedWorkAdmissions)
      .values({
        tenant_id: payload.tenant_id,
        kind,
        state: "pending",
        queue_name: queueName,
        job_id: jobId,
        owner_boot_id: tenantWorkSnapshot(payload.tenant_id).boot_id,
      })
      .returning();
    if (!row) throw new Error("Hosted work admission was not created");
    const sent = await boss.send(queueName, payload, {
      ...options,
      id: jobId,
      group: { id: payload.tenant_id },
      db: queuedSendTransaction(tx),
    });
    if (sent !== jobId)
      throw new HostedWorkQuotaError("Queue did not accept the hosted work admission");
    await record(tx, payload.tenant_id, row.id, AuditAction.HOSTED_WORK_ADMITTED, "queue_send");
    return sent;
  });
}

export async function withHostedWork<T>(
  db: Db,
  tenantId: string,
  kind: HostedWorkKind,
  operation: () => Promise<T>,
  job?: { queue: string; id: string },
): Promise<T> {
  const key = `${tenantId}:${kind}`;
  const inherited = context.getStore()?.get(key);
  if (inherited && running.has(inherited.id)) {
    const actual = Promise.resolve().then(operation);
    inherited.pending.add(actual);
    try {
      return await actual;
    } finally {
      inherited.pending.delete(actual);
    }
  }
  if (!(await hostedTenant(db, tenantId))) return operation();
  const limits = policy();
  const id = await db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    await hostedTenant(tx, tenantId, true);
    const rows = await listUnsettledHostedWork(tenantId, tx);
    const limit = kind === "execution" ? limits.execution_concurrency : limits.chat_concurrency;
    if (
      rows.filter(
        (row) =>
          row.kind === kind && (row.state === "active" || row.state === "reconciliation_required"),
      ).length >= limit
    )
      throw new HostedWorkQuotaError(
        "Hosted workspace active-work quota is exhausted; unresolved work requires operator reconciliation",
      );
    let id: string;
    if (job) {
      const row = rows.find((row) => row.queue_name === job.queue && row.job_id === job.id);
      if (!row || row.kind !== kind || row.state !== "pending")
        throw new HostedWorkQuotaError(
          "Queued hosted work has no pending admission; legacy or unresolved jobs require operator review",
        );
      id = row.id;
      await tx
        .update(hostedWorkAdmissions)
        .set({ state: "active", owner_boot_id: tenantWorkSnapshot(tenantId).boot_id })
        .where(and(eq(hostedWorkAdmissions.tenant_id, tenantId), eq(hostedWorkAdmissions.id, id)));
    } else {
      const [row] = await tx
        .insert(hostedWorkAdmissions)
        .values({
          tenant_id: tenantId,
          kind,
          state: "active",
          owner_boot_id: tenantWorkSnapshot(tenantId).boot_id,
        })
        .returning();
      if (!row) throw new Error("Hosted work admission was not created");
      id = row.id;
    }
    await record(
      tx,
      tenantId,
      id,
      AuditAction.HOSTED_WORK_STARTED,
      job ? "queue_claim" : "direct_call",
    );
    return id;
  });
  running.add(id);
  let succeeded = false;
  const scope: WorkScope = { id, pending: new Set() };
  try {
    return await context.run(new Map([...(context.getStore() ?? []), [key, scope]]), async () => {
      const result = await operation();
      succeeded = true;
      return result;
    });
  } finally {
    while (scope.pending.size > 0) await Promise.allSettled([...scope.pending]);
    try {
      await db.transaction(async (tx) => {
        await lockTenant(tx, tenantId);
        const state = job && !succeeded ? "pending" : "released";
        await tx
          .update(hostedWorkAdmissions)
          .set({ state, released_at: state === "released" ? new Date() : null })
          .where(
            and(
              eq(hostedWorkAdmissions.tenant_id, tenantId),
              eq(hostedWorkAdmissions.id, id),
              eq(hostedWorkAdmissions.state, "active"),
            ),
          );
        await record(
          tx,
          tenantId,
          id,
          AuditAction.HOSTED_WORK_FINISHED,
          state === "pending" ? "attempt_stopped_retry_pending" : "producer_settled",
        );
      });
    } finally {
      running.delete(id);
    }
  }
}

export async function releaseStoppedPendingHostedWork(
  tenantId: string,
  boss: Pick<PgBoss, "findJobs">,
  db: Executor,
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const rows = await listUnsettledHostedWork(tenantId, tx);
    let released = 0;
    for (const row of rows) {
      if (row.state !== "pending" || !row.queue_name || !row.job_id) continue;
      const jobs = await boss.findJobs(row.queue_name, { id: row.job_id });
      if (jobs.some((job) => !["completed", "cancelled", "failed"].includes(job.state))) continue;
      await tx
        .update(hostedWorkAdmissions)
        .set({ state: "released", released_at: new Date() })
        .where(
          and(
            eq(hostedWorkAdmissions.tenant_id, tenantId),
            eq(hostedWorkAdmissions.id, row.id),
            eq(hostedWorkAdmissions.state, "pending"),
          ),
        );
      await record(
        tx,
        tenantId,
        row.id,
        AuditAction.HOSTED_WORK_FINISHED,
        "public_queue_terminal_or_absent",
      );
      released += 1;
    }
    return released;
  });
}

export function isHostedWorkRunningLocally(id: string): boolean {
  return running.has(id);
}

export function hostedQueueGroupConcurrency(kind: HostedWorkKind): number {
  try {
    const limits = getConfig().queue.hosted;
    return (kind === "execution" ? limits.execution_concurrency : limits.chat_concurrency) || 1;
  } catch {
    return 1;
  }
}

export function queueWorkerConcurrency(): number {
  try {
    return getConfig().queue.concurrency;
  } catch {
    return 1;
  }
}

export async function ifHostedJobStillPending<T>(
  db: Db,
  tenantId: string,
  queueName: string,
  jobId: string,
  operation: (exec: Executor) => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const [row] = await tx
      .select({ state: hostedWorkAdmissions.state })
      .from(hostedWorkAdmissions)
      .where(
        and(
          eq(hostedWorkAdmissions.tenant_id, tenantId),
          eq(hostedWorkAdmissions.queue_name, queueName),
          eq(hostedWorkAdmissions.job_id, jobId),
        ),
      )
      .limit(1);
    if (row?.state !== "pending") return undefined;
    return await operation(tx);
  });
}
