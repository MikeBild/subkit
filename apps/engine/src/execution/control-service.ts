import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { actorType } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { clearDeviceWait } from "../devices/waiting.ts";
import { logger } from "../logging/index.ts";
import { findAllJobs } from "../queue/list-all.ts";
import { EXECUTION_RUN_DEVICE_QUEUE, EXECUTION_RUN_QUEUE } from "../queue/queues.ts";
import { verifySignalToken } from "../workflow-signals/index.ts";
import { cancel as abortCancel } from "./abort.ts";
import { executionVisibilityFilter } from "./execution-owner.ts";
import { findOwnedExecution } from "./read-service.ts";
import { finalizeExecution, requestExecutionAbort } from "./state.ts";

interface CancelExecutionRequest {
  principal: ResolvedPrincipal;
  execution_id: string;
  request_source: string;
  boss?: PgBoss | undefined;
}

async function cancelQueuedJobs(boss: PgBoss | undefined, execution_id: string): Promise<void> {
  try {
    const { getBoss } = await import("../queue/boss.ts");
    const queue = boss ?? getBoss();
    for (const name of [EXECUTION_RUN_QUEUE, EXECUTION_RUN_DEVICE_QUEUE]) {
      const jobs = await findAllJobs<{ execution_id: string }>(queue, name, {
        data: { execution_id },
      });
      if (jobs.length > 0) {
        const ids = jobs.map((j: { id: string }) => j.id);
        await queue.cancel(name, ids);
      }
    }
  } catch (err) {
    logger.debug({
      module: "queue",
      action: "cancel.skipped",
      msg: "could not cancel queued job (pg-boss not started or no matching job)",
      execution_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function cancelExecutionRequest(
  db: Db,
  request: CancelExecutionRequest,
): Promise<boolean> {
  const { principal, execution_id } = request;
  const row = await findOwnedExecution(db, principal, execution_id);
  if (!row) return false;
  if (row.status === "queued" || row.status === "waiting_for_device" || row.status === "running") {
    await requestExecutionAbort(db, {
      tenant_id: principal.tenant_id,
      execution_id,
      actor_type: actorType(principal),
      actor_id: principal.id,
      request_source: request.request_source,
    });
  }
  if (row.status === "queued" || row.status === "waiting_for_device") {
    await cancelQueuedJobs(request.boss, execution_id);
    await clearDeviceWait(db, principal.tenant_id, execution_id);
    await finalizeExecution(db, principal.tenant_id, execution_id, { type: "cancelled" });
  }
  abortCancel(execution_id, "cancelled");
  return true;
}

type SignalTarget =
  | { ok: true; tenant_id: string; input: unknown }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "token_rejected"; detail: string };

export async function findTokenSignalTarget(
  db: Db,
  params: { execution_id: string; token: string; event_name: string },
): Promise<SignalTarget> {
  // tenant-filter:exempt — token-mediated lookup by globally-unique execution_id; tenant_id is read out and verified against the signed HMAC token below
  const rows = await db
    .select({ id: executions.id, tenant_id: executions.tenant_id, input: executions.input })
    .from(executions)
    .where(eq(executions.id, params.execution_id))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  const verdict = verifySignalToken(params.token, {
    tenant_id: row.tenant_id,
    execution_id: params.execution_id,
    event_name: params.event_name,
  });
  if (!verdict.ok) return { ok: false, reason: "token_rejected", detail: verdict.reason };
  return { ok: true, tenant_id: row.tenant_id, input: row.input };
}

export async function findPrincipalSignalTarget(
  db: Db,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<SignalTarget> {
  const rows = await db
    .select({ id: executions.id, input: executions.input })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, principal.tenant_id),
        eq(executions.id, execution_id),
        executionVisibilityFilter(principal),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  return { ok: true, tenant_id: principal.tenant_id, input: row.input };
}
