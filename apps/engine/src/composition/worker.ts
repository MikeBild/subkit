import type { PgBoss } from "pg-boss";
import type { ChatAdapterRegistry } from "../chat/registry.ts";
import { getConfig } from "../config/loader.ts";
import { type Db, getPool, readAdvisoryLockSnapshot } from "../db/client.ts";
import { printIssuedKey, seedAtBoot } from "../db/seed.ts";
import { deviceLifecycleHandler } from "../devices/waiting.ts";
import { type EngineBootLifetime, EngineBootStoppedError } from "../engine-boot-lifetime.ts";
import { startAbortMonitor } from "../execution/index.ts";
import {
  recoverCrashedExecutions,
  type StaleRunEnqueue,
  startCrashRecoveryMonitor,
} from "../execution/recovery.ts";
import { reapOrphanedWaits } from "../execution/wait-reaper.ts";
import type { LocalWorkspace } from "../identity/local-workspace.ts";
import { seedKnowledgeAtBoot } from "../knowledge/seed.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  diagnoseOperation,
  runtimeDiagnosticsEnabled,
  startRuntimeDiagnosticSampler,
} from "../observability/runtime-diagnostics.ts";
import { bootPhase } from "../observability/runtime-telemetry.ts";
import { startListener, stopListener } from "../pubsub/listener.ts";
import { bossPoolCounts, startBoss, stopBoss } from "../queue/boss.ts";
import { EVENT_FANOUT_QUEUE } from "../queue/handlers/event-fanout.ts";
import { registerAllHandlers } from "../queue/handlers/index.ts";
import { registerTaskRunTurnListener } from "../queue/handlers/task-run-turn.ts";
import { EXECUTION_RUN_QUEUE, enqueueHostedWork } from "../queue/index.ts";
import { rememberWorkerRegistration } from "../queue/worker-pause.ts";
import { prewarmSandboxWorkers } from "../sandboxes/quickjs/runtime.ts";
import { applySkillSeedsForAllTenants, loadEmbeddedSkillSeeds } from "../skills/seed.ts";
import { SHUTDOWN_DRAIN_TIMEOUT_MS } from "./shutdown.ts";

export interface WorkerDeps {
  readonly lifetime: EngineBootLifetime;
  readonly chatRegistry: ChatAdapterRegistry;
  readonly localWorkspace: LocalWorkspace | null;
  readonly recordBootConsumer: (name: string) => void;
}

export interface Worker {
  readonly boss: PgBoss;
}

export async function startWorker(db: Db, deps: WorkerDeps): Promise<Worker> {
  const { lifetime, chatRegistry, localWorkspace } = deps;
  const boss = await lifetime.acquire(
    () => bootPhase("queue_start", () => startBoss({ connectionString: getConfig().database.url })),
    (resource) =>
      resource.stop({ close: false, graceful: true, timeout: SHUTDOWN_DRAIN_TIMEOUT_MS }),
    () => stopBoss(SHUTDOWN_DRAIN_TIMEOUT_MS),
  );
  deps.recordBootConsumer("queue");
  registerTaskRunTurnListener();
  await lifetime.step(() =>
    bootPhase("queue_handlers", () => registerAllHandlers({ boss, db, chatRegistry })),
  );
  if (localWorkspace)
    rememberWorkerRegistration(boss, () => registerAllHandlers({ boss, db, chatRegistry }));
  if (runtimeDiagnosticsEnabled()) {
    const appPool = getPool();
    await lifetime.acquire(
      () =>
        startRuntimeDiagnosticSampler({
          appPool: () => ({
            total: appPool.totalCount,
            idle: appPool.idleCount,
            waiting: appPool.waitingCount,
            max: appPool.options.max,
          }),
          bossPool: () => bossPoolCounts(boss),
          advisoryLockSnapshot: () => readAdvisoryLockSnapshot(appPool),
        }),
      (stop) => stop(),
    );
  }

  await hydrateChat(db, deps);
  await recoverExecutions(db, boss, deps);
  await reapWaits(db, boss, lifetime);
  await startEventListener(db, boss, lifetime);
  return { boss };
}

async function hydrateChat(db: Db, { lifetime, chatRegistry }: WorkerDeps): Promise<void> {
  try {
    const { hydrateChatRegistry } = await lifetime.step(() => import("../chat/hydrate.ts"));
    const outcome = await lifetime.step(() => hydrateChatRegistry(db, chatRegistry));
    logger.info({
      module: "engine",
      action: "chat.hydrate.summary",
      msg: "chat-bridge hydration summary",
      total: outcome.total,
      slack: outcome.slack,
      skipped: outcome.skipped,
      fallback_registered_for: outcome.fallback_registered_for,
    });
  } catch (err) {
    if (err instanceof EngineBootStoppedError) throw err;
    logger.warn({
      module: "engine",
      action: "chat.hydrate.failed",
      msg: "chat-bridge hydration failed at boot; chat ingestion will return 503 until fixed",
      ...errorFields(err),
    });
  }
}

const STALE_RUN_REQUEUE_WINDOW_SECONDS = 300;

async function recoverExecutions(
  db: Db,
  boss: PgBoss,
  { lifetime, recordBootConsumer }: WorkerDeps,
) {
  const enqueue: StaleRunEnqueue = async (job) => {
    await enqueueHostedWork(db, boss, "execution", EXECUTION_RUN_QUEUE, job, {
      singletonKey: `crash-resume:${job.execution_id}`,
      singletonSeconds: STALE_RUN_REQUEUE_WINDOW_SECONDS,
    });
  };
  try {
    const overrideThresholdMs = getConfig().queue.crash_recovery_threshold_ms;
    const { recovered, reconciled_steps } = await lifetime.step(() =>
      recoverCrashedExecutions(db, {
        enqueue,
        ...(overrideThresholdMs > 0 ? { overrideThresholdMs } : {}),
      }),
    );
    logger.info({
      module: "queue",
      action: "crash_recovery_complete",
      msg: "boot-time crash recovery sweep finished",
      recovered,
      reconciled_steps,
    });
  } catch (err) {
    if (err instanceof EngineBootStoppedError) throw err;
    logger.error({
      module: "queue",
      action: "crash_recovery_failed",
      msg: "boot-time crash recovery sweep failed (non-fatal)",
      ...errorFields(err),
    });
  }
  await lifetime.acquire(
    () => startCrashRecoveryMonitor(db, { enqueue }),
    (monitor) => monitor.stop(),
  );
  recordBootConsumer("crash-recovery");
}

async function reapWaits(db: Db, boss: PgBoss, lifetime: EngineBootLifetime): Promise<void> {
  try {
    const { reaped } = await lifetime.step(() => reapOrphanedWaits(db, boss));
    if (reaped > 0) {
      logger.info({
        module: "execution",
        action: "wait_reaper.boot_complete",
        msg: "boot-time wait reaper finished",
        reaped,
      });
    }
  } catch (err) {
    if (err instanceof EngineBootStoppedError) throw err;
    logger.error({
      module: "execution",
      action: "wait_reaper.boot_failed",
      msg: "boot-time wait reaper failed (non-fatal)",
      ...errorFields(err),
    });
  }
}

async function startEventListener(
  db: Db,
  boss: PgBoss,
  lifetime: EngineBootLifetime,
): Promise<void> {
  const listener = await lifetime.acquire(
    () =>
      bootPhase("pubsub_listener", () =>
        startListener({ connectionString: getConfig().database.url, db }),
      ),
    stopListener,
  );
  await lifetime.acquire(
    () => startAbortMonitor(db),
    (monitor) => monitor.stop(),
  );
  for (const channel of ["execution.status", "notification.emitted"] as const) {
    lifetime.registerStop(
      listener.on(channel, async (event) => {
        if (lifetime.stopping) return;
        try {
          await boss.send(EVENT_FANOUT_QUEUE, { event_row_id: event.id });
        } catch (err) {
          logger.error({
            module: "pubsub",
            action: "fanout.enqueue_failed",
            msg: "failed to enqueue event.fanout job",
            channel,
            event_id: event.id,
            ...errorFields(err),
          });
        }
      }),
    );
  }
  const onDeviceLifecycle = deviceLifecycleHandler(db, boss, () => lifetime.stopping);
  lifetime.registerStop(listener.on("resource.lifecycle", onDeviceLifecycle));
}

export interface BootSeedDeps {
  readonly lifetime: EngineBootLifetime;
  readonly seedSkills: boolean;
}

export async function runBootSeeds(db: Db, { lifetime, seedSkills }: BootSeedDeps): Promise<void> {
  try {
    const seedResult = await lifetime.step(() => seedAtBoot(db));
    for (const key of seedResult.issued_keys) {
      printIssuedKey(key, { source: "boot" });
    }
    logger.info({
      module: "engine",
      action: "seed.at_boot_complete",
      msg: "boot-time seed pass complete",
      status: seedResult.status,
      new_keys_issued: seedResult.issued_keys.length,
    });
    const { operatorTenant } = await lifetime.step(() => import("../rbac/operator.ts"));
    const operator = await lifetime.step(() => operatorTenant(db));
    if (operator) {
      logger.info({
        module: "rbac",
        action: "operator.resolved",
        msg: "engine operator workspace resolved",
        tenant_id: operator.id,
        tenant_slug: operator.slug,
      });
    } else {
      logger.warn({
        module: "rbac",
        action: "operator.missing",
        msg: "no engine operator workspace is assigned; engine-wide settings stay locked until setup completes or engine --set-operator-tenant <slug> runs",
      });
    }
  } catch (err) {
    if (err instanceof EngineBootStoppedError) throw err;
    logger.error({
      module: "engine",
      action: "seed.at_boot_failed",
      msg: "boot-time seed failed (non-fatal); auth may degrade until next boot",
      ...errorFields(err),
    });
  }

  lifetime.background(
    async () => {
      try {
        if (seedSkills) await seedEmbeddedSkills(db);
      } finally {
        if (!lifetime.stopping)
          await diagnoseOperation({
            action: "boot.knowledge_seed",
            fn: () => seedKnowledgeAtBoot(db),
          });
        if (!lifetime.stopping) await prewarmSandbox();
      }
    },
    (error) =>
      logger.error({
        module: "engine",
        action: "knowledge.seed.failed",
        msg: "background seed failed",
        ...errorFields(error),
      }),
  );
}

async function seedEmbeddedSkills(db: Db): Promise<void> {
  try {
    const loaded = loadEmbeddedSkillSeeds();
    if (loaded.errors.length > 0) {
      logger.warn({
        module: "skills.seed",
        action: "seed.parse_errors",
        msg: "some embedded skill seeds failed to parse",
        errors: loaded.errors.map((e) => ({ file: e.file, code: e.code })),
      });
    }
    if (loaded.skills.length === 0) {
      logger.info({
        module: "skills.seed",
        action: "seed.empty",
        msg: "no skill seeds embedded in this binary; skipping",
        embedded_count: loaded.embedded_count,
      });
      return;
    }
    const outcomes = await diagnoseOperation({
      action: "boot.skill_seed",
      fn: () => applySkillSeedsForAllTenants(loaded.skills, db),
    });
    const totals = outcomes.reduce(
      (acc, o) => {
        acc.inserted += o.inserted;
        acc.updated += o.updated;
        acc.unchanged += o.unchanged;
        return acc;
      },
      { inserted: 0, updated: 0, unchanged: 0 },
    );
    logger.info({
      module: "skills.seed",
      action: "seed.applied",
      msg: "skill seeds applied across tenants",
      tenants: outcomes.length,
      skills_per_tenant: loaded.skills.length,
      embedded_count: loaded.embedded_count,
      ...totals,
    });
  } catch (err) {
    logger.error({
      module: "skills.seed",
      action: "seed.failed",
      msg: "skill seed apply failed (non-fatal)",
      ...errorFields(err),
    });
  }
}

async function prewarmSandbox(): Promise<void> {
  try {
    if (await prewarmSandboxWorkers()) {
      logger.info({
        module: "sandbox",
        action: "worker.prewarmed",
        msg: "sandbox worker started ahead of the first job",
      });
    }
  } catch (err) {
    logger.warn({
      module: "sandbox",
      action: "worker.prewarm_failed",
      msg: "sandbox worker prewarm failed (non-fatal); the first job starts it instead",
      ...errorFields(err),
    });
  }
}
