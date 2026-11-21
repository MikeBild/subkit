import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/index.ts";

interface RegisteredAbort {
  controller: AbortController;
  tenant_id: string;
}

const REGISTRY = new Map<string, RegisteredAbort>();

export function registerAbort(executionId: string, tenantId: string): AbortController {
  const ctrl = new AbortController();
  REGISTRY.set(executionId, { controller: ctrl, tenant_id: tenantId });
  return ctrl;
}

export function unregisterAbort(executionId: string): void {
  REGISTRY.delete(executionId);
}

export function cancel(executionId: string, reason = "cancelled"): boolean {
  const registered = REGISTRY.get(executionId);
  if (!registered || registered.controller.signal.aborted) return false;
  registered.controller.abort(reason);
  return true;
}

interface AbortMonitor {
  stop(): Promise<void>;
  checkNow(): Promise<number>;
}

export function startAbortMonitor(
  db: Db,
  options: { intervalMs?: () => number } = {},
): AbortMonitor {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeCheck: Promise<number> | null = null;

  const intervalMs = options.intervalMs ?? (() => getConfig().queue.abort_poll_interval_ms);

  const checkNow = async (): Promise<number> => {
    if (stopped) throw new Error("abort_monitor_stopped");
    if (activeCheck) return activeCheck;
    activeCheck = (async () => {
      const byTenant = new Map<string, string[]>();
      for (const [executionId, registered] of REGISTRY) {
        const ids = byTenant.get(registered.tenant_id) ?? [];
        ids.push(executionId);
        byTenant.set(registered.tenant_id, ids);
      }

      let signaled = 0;
      for (const [tenantId, executionIds] of byTenant) {
        if (executionIds.length === 0) continue;
        const rows = await db
          .select({ id: executions.id })
          .from(executions)
          .where(
            and(
              eq(executions.tenant_id, tenantId),
              inArray(executions.id, executionIds),
              isNotNull(executions.abort_requested_at),
            ),
          );
        for (const row of rows) {
          if (cancel(row.id, "cancelled")) signaled += 1;
        }
      }
      return signaled;
    })();
    try {
      return await activeCheck;
    } finally {
      activeCheck = null;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      void checkNow()
        .catch((err) => {
          logger.error({
            module: "execution",
            action: "abort_monitor.check_failed",
            msg: "durable execution cancellation check failed",
            ...errorFields(err),
          });
        })
        .finally(schedule);
    }, intervalMs());
  };

  schedule();
  return {
    checkNow,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await activeCheck;
    },
  };
}

export function combineSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
