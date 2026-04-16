// pg-boss handler for `chat.event` jobs.
//
// Consumes normalized ChatEvent envelopes and hands them to the
// dispatcher. pg-boss already retries failed jobs according to the
// queue definition (see queues.ts) and dumps terminal failures into
// the DLQ — no bespoke retry logic lives here.

import type { PgBoss } from "pg-boss";
import { type DispatchRunEnqueue, handleChatEvent } from "../../chat/dispatcher.ts";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { ChatEvent } from "../../chat/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";

export interface ChatEventHandlerDeps {
  db: Db;
  registry: ChatAdapterRegistry;
  /** Optional pg-boss instance — when present, `/subkit run` slash
   * commands are enqueued as execution.run jobs. Tests usually omit
   * this so the dispatcher only materializes the executions row. */
  boss?: PgBoss;
}

export interface ChatEventJob {
  event: ChatEvent;
  /** Resolved tenant id (optional — the dispatcher re-resolves from
   * chat_workspaces anyway). */
  tenant_id?: string;
}

/** Returns a pg-boss work handler closure bound to the given deps. */
export function createChatEventHandler(
  deps: ChatEventHandlerDeps,
): (jobs: Array<{ data: ChatEventJob }>) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const { event } = job.data;
      const adapter = deps.registry.findVerifier(event.platform);
      if (!adapter) {
        logger.warn({
          module: "chat.queue",
          action: "chat_event.no_adapter",
          msg: "no adapter registered for platform",
          platform: event.platform,
        });
        continue;
      }
      const enqueueRun = deps.boss
        ? async (run: DispatchRunEnqueue) => {
            const job: ExecutionRunJob = {
              tenant_id: run.tenant_id,
              workflow_id: run.workflow_id,
              execution_id: run.execution_id,
              input: run.input,
              request_source: run.request_source,
              trace_id: run.trace_id,
            };
            await deps.boss?.send(EXECUTION_RUN_QUEUE, job);
          }
        : undefined;
      try {
        await handleChatEvent(
          { db: deps.db, adapter, ...(enqueueRun ? { enqueueRun } : {}) },
          event,
        );
      } catch (err) {
        logger.error({
          module: "chat.queue",
          action: "chat_event.failed",
          msg: "dispatcher failed",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  };
}
