import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { type EngineBootLifetime, installEngineScheduler } from "../engine-boot-lifetime.ts";
import type { LocalWorkspace } from "../identity/local-workspace.ts";
import { errorFields, logger } from "../logging/index.ts";
import { SchedulerReconciler } from "../scheduler/reconciler.ts";

const RESTART_REMINDER_INTERVAL_MS = 5 * 60 * 1000;

export interface SchedulerDeps {
  readonly lifetime: EngineBootLifetime;
  readonly boss: PgBoss;
  readonly localWorkspace: LocalWorkspace | null;
  readonly onFirstSweepFailed: () => void;
  readonly recordBootConsumer: (name: string) => void;
}

export function startScheduler(db: Db, deps: SchedulerDeps): void {
  const { lifetime, boss, localWorkspace } = deps;
  lifetime.assertRunning();
  const reconciler = new SchedulerReconciler({ boss, db, backgroundWork: localWorkspace?.power });
  installEngineScheduler(lifetime, reconciler, {
    completed: () =>
      logger.info({
        module: "scheduler",
        action: "first_sweep.completed",
        msg: "initial scheduler sweep completed",
      }),
    failed: (error) => {
      deps.onFirstSweepFailed();
      logger.error({
        module: "scheduler",
        action: "first_sweep.failed",
        msg: "initial scheduler sweep failed",
        ...errorFields(error),
      });
    },
  });
  deps.recordBootConsumer("scheduler");
  logger.info({
    module: "scheduler",
    action: "consumer.installed",
    msg: "scheduler consumer installed; first sweep pending",
  });
  startRestartReminder(lifetime);
}

function startRestartReminder(lifetime: EngineBootLifetime): void {
  const timer = setInterval(() => {
    if (lifetime.stopping) return;
    lifetime.background(
      async () => {
        try {
          const { emitRequiresRestartPendingIfAny } = await import("../config/loader.ts");
          if (!lifetime.stopping) await emitRequiresRestartPendingIfAny();
        } catch {}
      },
      (error) =>
        logger.warn({
          module: "runtime_config",
          action: "restart.reminder_failed",
          msg: "restart reminder failed",
          ...errorFields(error),
        }),
    );
  }, RESTART_REMINDER_INTERVAL_MS);
  lifetime.registerStop(() => clearInterval(timer));
  if (typeof timer.unref === "function") timer.unref();
}
