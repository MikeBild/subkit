// Process-local map: execution_id -> AbortController. POST
// /v1/executions/:id/cancel looks the controller up here and fires
// `abort('cancelled')`. The map is cleaned up automatically when the
// execution finishes.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

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

export function getAbort(executionId: string): AbortController | undefined {
  return REGISTRY.get(executionId)?.controller;
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

export interface AbortMonitor {
  stop(): void;
  checkNow(): Promise<number>;
}

/**
 * Observe the durable abort_requested_at flag for executions owned by this
 * process. One batched query per active tenant keeps the control path bounded;
 * the next delay is read after every cycle so queue.abort_poll_interval_ms
 * hot-reloads without restarting a worker.
 */
export function startAbortMonitor(
  db: Db,
  options: { intervalMs?: () => number } = {},
): AbortMonitor {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeCheck: Promise<number> | null = null;

  const intervalMs = options.intervalMs ?? (() => getConfig().queue.abort_poll_interval_ms);

  const checkNow = async (): Promise<number> => {
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
      void checkNow()
        .catch((err) => {
          logger.error({
            module: "execution",
            action: "abort_monitor.check_failed",
            msg: "durable execution cancellation check failed",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(schedule);
    }, intervalMs());
  };

  schedule();
  return {
    checkNow,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// Combine an external signal (e.g. parent execution's abort) with a
// per-step timeout signal so the step honors whichever fires first.
//
// Uses the platform `AbortSignal.any` rather than hand-rolled
// addEventListener wiring: the manual version registered a listener on
// each LONG-LIVED parent signal (the execution-scoped controller) per
// step and never removed it, so listeners — and the per-step closures
// they captured — accumulated on the parent for the whole execution
// (MaxListenersExceededWarning + memory retention on long runs).
// `AbortSignal.any` manages its source subscriptions internally and
// releases them when the derived signal becomes unreachable.
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
