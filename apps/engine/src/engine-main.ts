import { checkForUpdate, defaultUpdaterConfig } from "@cli-core/updater.ts";
import { serve } from "@hono/node-server";
import { SYSTEM_TENANT_ID } from "./audit/index.ts";
import { ChatAdapterRegistry } from "./chat/registry.ts";
import { SkCliAdapter } from "./chat/sk-cli/adapter.ts";
import { closeAllPools } from "./connectors/drivers/postgres.ts";
import { assertCryptoKeyOrExit } from "./crypto/aes-gcm.ts";
import { closeDb, getDb, getPool } from "./db/client.ts";
import { type DriftReport, detectDrift, runMigrationsFromUrl } from "./db/migrate.ts";
import { printIssuedKey, seedAtBoot } from "./db/seed.ts";
import { warmEmbeddings } from "./embeddings/local-provider.ts";
import {
  EngineBootLifetime,
  EngineBootStoppedError,
  installEngineScheduler,
} from "./engine-boot-lifetime.ts";
import {
  startAbortMonitor,
  tenantWorkInFlight,
  waitForTenantWorkDrain,
} from "./execution/index.ts";
import { recoverCrashedExecutions, startCrashRecoveryMonitor } from "./execution/recovery.ts";
import { reapOrphanedWaits } from "./execution/wait-reaper.ts";
import { getScanner, NoopScanner } from "./files/scanner.ts";
import { setHealthState } from "./http/health-state.ts";
import { engineServeOptions } from "./http/listen-hostname.ts";
import { OPENAPI_INFO } from "./http/openapi.ts";
import { createApp } from "./http/server.ts";
import type { HttpShutdown } from "./http/shutdown.ts";
import { beginHttpShutdown } from "./http/shutdown.ts";
import { seedKnowledgeAtBoot } from "./knowledge/seed.ts";
import { newTraceId, withContext } from "./logging/context.ts";
import { errorFields, logger } from "./logging/logger.ts";
import {
  bootPhase,
  readMemoryUsage,
  startBootHeartbeat,
  startEventLoopLagMonitor,
  startMemorySampler,
} from "./observability/runtime-telemetry.ts";
import { startTracing } from "./observability/tracing.ts";
import * as bootstrap from "./onboarding/bootstrap.ts";
import { startListener, stopListener } from "./pubsub/listener.ts";
import { startBoss, stopBoss } from "./queue/boss.ts";
import { EVENT_FANOUT_QUEUE } from "./queue/handlers/event-fanout.ts";
import { registerAllHandlers } from "./queue/handlers/index.ts";
import type { RuntimeConfigCoordinator as Coordinator } from "./runtime-config/coordinator.ts";
import { registerRestartTrigger, shutdownExitCode } from "./runtime-config/restart.ts";
import { closeSandboxWorkers } from "./sandboxes/quickjs/runtime.ts";
import { SchedulerReconciler } from "./scheduler/reconciler.ts";
import { applySkillSeedsForAllTenants, loadEmbeddedSkillSeeds } from "./skills/seed.ts";
import { startEngineUpdateCheck } from "./update-state.ts";

const SMOKE_FLAG = "--smoke";
const SELF_UPDATE_FLAG = "--self-update";
const ROLLBACK_FLAG = "--rollback";
const CHECK_UPDATE_FLAG = "--check-update";
const MIGRATE_FLAG = "--migrate";
const SEED_FLAG = "--seed";
const ISSUE_ADMIN_KEY_FLAG = "--issue-admin-key";
const SET_OPERATOR_TENANT_FLAG = "--set-operator-tenant";
const TOKEN_EXCHANGE_FLAG = "--token-exchange";
const VERSION_FLAG = "--version";
const HELP_FLAG = "--help";
async function runServer(): Promise<void> {
  const lifetime = new EngineBootLifetime();
  let runtimeConfigCoordinator: Coordinator | undefined;
  let httpShutdown: HttpShutdown | undefined;
  let databaseAcquired = false;
  let shutting: Promise<void> | undefined;
  let requestedExitCode = shutdownExitCode("signal");
  const SHUTDOWN_DRAIN_TIMEOUT_MS = 120_000;
  const shutdown = (
    signal: NodeJS.Signals | "restart" | "boot_failure",
    exitCode = shutdownExitCode("signal"),
  ): Promise<void> => {
    if (exitCode !== 0) requestedExitCode = exitCode;
    if (shutting) return shutting;
    setHealthState({ draining: true });
    logger.info({
      module: "engine",
      action: "shutdown.begin",
      msg: `received ${signal}, shutting down`,
    });
    const hardKill = setTimeout(() => {
      logger.error({
        module: "engine",
        action: "shutdown.hard_kill",
        msg: "graceful shutdown timed out, exiting forcibly",
      });
      process.exit(shutdownExitCode("timeout"));
    }, SHUTDOWN_DRAIN_TIMEOUT_MS + 20_000);
    hardKill.unref?.();
    const drained = lifetime.stop();
    const forceHttpClose = setTimeout(() => httpShutdown?.forceClose(), SHUTDOWN_DRAIN_TIMEOUT_MS);
    forceHttpClose.unref?.();
    shutting = (async () => {
      try {
        await drained;
        httpShutdown?.forceClose();
        let httpClosed = httpShutdown ? await httpShutdown.waitUntilClosed(1_000) : true;
        if (!httpClosed)
          logger.warn({
            module: "http",
            action: "shutdown.http_force_close_timeout",
            msg: "HTTP close callback remained pending after force-closing connections",
            timeout_ms: 1_000,
          });
        if (httpShutdown && !httpClosed) {
          await httpShutdown.closed;
          httpClosed = true;
        }
        await waitForTenantWorkDrain();
        await lifetime.finalize();
        closeSandboxWorkers();
        await closeAllPools();
        const inFlight = tenantWorkInFlight();
        if (httpClosed && inFlight === 0) await runtimeConfigCoordinator?.stop();
        else
          logger.warn({
            module: "runtime_config",
            action: "shutdown.replica_registration_retained",
            msg: "Shutdown has unsettled work; replica registration retained for operator review",
            http_closed: httpClosed,
            in_flight: inFlight,
          });
        if (databaseAcquired) await closeDb();
        logger.info({
          module: "engine",
          action: "shutdown.complete",
          msg: "graceful shutdown complete",
        });
      } catch (error) {
        requestedExitCode = shutdownExitCode("timeout");
        logger.error({
          module: "engine",
          action: "shutdown.error",
          msg: "error during shutdown",
          ...errorFields(error),
        });
      }
      clearTimeout(forceHttpClose);
      clearTimeout(hardKill);
      process.exit(requestedExitCode);
    })();
    return shutting;
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  const unregisterRestart = registerRestartTrigger(
    () => void shutdown("restart", shutdownExitCode("restart")),
  );
  lifetime.registerStop(unregisterRestart);
  try {
    const stopBootHeartbeat = startBootHeartbeat();
    lifetime.registerStop(stopBootHeartbeat);

    const { loadConfig, getConfig, recordBootConsumer, emitBootComplete } = await lifetime.step(
      () => import("./config/loader.ts"),
    );
    const { reconfigureLogger, reconfigureObservability } = await lifetime.step(
      () => import("./logging/logger.ts"),
    );
    await lifetime.step(() => bootPhase("config_load", () => loadConfig()));
    const cfg = getConfig();
    reconfigureLogger({ level: cfg.log.level, format: cfg.log.format });
    reconfigureObservability({
      field_truncation_chars: cfg.observability.field_truncation_chars,
      service_name: cfg.observability.otlp.service_name,
      deployment_environment: cfg.observability.deployment_environment,
    });
    recordBootConsumer("logger");
    if (getScanner() === NoopScanner && process.env.NODE_ENV === "production") {
      logger.info({
        module: "files",
        action: "scanner.noop_in_production",
        msg: "FileScanner is NoopScanner (accepted risk, see AGENTS.md). Uploads are reported clean without AV scanning; tenant uploads are not a primary attack surface today.",
      });
    }

    const { runProductionPreflightOrExit } = await lifetime.step(
      () => import("./preflight/runner.ts"),
    );
    await lifetime.step(() => bootPhase("crypto_assert", () => assertCryptoKeyOrExit()));
    const db = getDb();
    databaseAcquired = true;
    const { assertVaultMasterKey, initializeRuntimeConfig, pinVaultMasterKey } =
      await lifetime.step(() => import("./runtime-config/service.ts"));
    const { RuntimeConfigCoordinator } = await lifetime.step(
      () => import("./runtime-config/coordinator.ts"),
    );
    const coordinator = new RuntimeConfigCoordinator(db, OPENAPI_INFO.version);
    runtimeConfigCoordinator = coordinator;
    lifetime.registerStop(() => coordinator.pause());
    const chatRegistry = new ChatAdapterRegistry();
    chatRegistry.registerFallback("sk_cli", new SkCliAdapter(db));

    await lifetime.step(() =>
      coordinator.registerStartup(async (tx) => {
        await lifetime.step(() =>
          bootPhase("preflight", () => runProductionPreflightOrExit(db, cfg)),
        );
        try {
          await lifetime.step(() =>
            bootPhase("migrations", () => runMigrationsFromUrl(cfg.database.url)),
          );
        } catch (err) {
          if (err instanceof EngineBootStoppedError) throw err;
          logger.fatal({
            module: "engine",
            action: "migrate.failed_aborting_boot",
            msg: "embedded migrations failed; aborting boot to avoid running on a half-migrated schema",
            ...errorFields(err),
          });
          throw err;
        }
        lifetime.assertRunning();
        const { assertSearchPathOrAbort } = await lifetime.step(
          () => import("./db/assert-search-path-or-abort.ts"),
        );
        await lifetime.step(() => bootPhase("search_path", assertSearchPathOrAbort));
        await lifetime.step(() => assertVaultMasterKey(tx));
        await lifetime.step(() =>
          bootPhase("runtime_config", () => initializeRuntimeConfig(db, cfg)),
        );
        await lifetime.step(() => pinVaultMasterKey(tx));
      }),
    );
    await lifetime.step(() => bootPhase("runtime_config_coordinator", () => coordinator.start()));
    const restart = await lifetime.step(() => import("./runtime-config/restart.ts"));
    await lifetime.step(() =>
      bootPhase("restart_outcome", () => restart.answerRestartRequestAtBoot(db)),
    );
    recordBootConsumer("runtime-config");

    await lifetime.acquire(
      startTracing,
      () => {},
      (stop) => stop(),
    );
    recordBootConsumer("tracing");

    if (getConfig().operations.update_check_enabled)
      lifetime.background(
        () => startEngineUpdateCheck(OPENAPI_INFO.version),
        (error) =>
          logger.warn({
            module: "engine",
            action: "update.check_failed",
            msg: "engine update check failed",
            ...errorFields(error),
          }),
      );

    const { validateBootDependencies } = await lifetime.step(
      () => import("./observability/boot-dependencies.ts"),
    );
    await lifetime.step(() => bootPhase("boot_dependencies", () => validateBootDependencies(db)));

    let drift: DriftReport | null = null;
    try {
      drift = await lifetime.step(() => detectDrift(db));
      if (drift.historical_in_db.length > 0) {
        logger.info({
          module: "engine",
          action: "migrate.historical_rows_detected",
          msg: "DB carries accepted pre-squash migration history",
          historical_count: drift.historical_in_db.length,
        });
      }
      const schemaDrift = drift.unknown_in_db.length > 0 || drift.missing_in_db.length > 0;
      if (schemaDrift) {
        logger.warn({
          module: "engine",
          action: "migrate.drift_detected",
          msg: "migration identities do not match the running binary",
          unknown_count: drift.unknown_in_db.length,
          missing_count: drift.missing_in_db.length,
          first_unknown_tags: drift.unknown_in_db.slice(0, 10).map((r) => r.tag),
          first_missing_tags: drift.missing_in_db.slice(0, 10).map((r) => r.tag),
        });
      }
      setHealthState({ schema_drift: schemaDrift });
    } catch (err) {
      if (err instanceof EngineBootStoppedError) throw err;
      logger.error({
        module: "engine",
        action: "migrate.drift_check_failed",
        msg: "drift detection failed (non-fatal)",
        ...errorFields(err),
      });
    }

    try {
      await lifetime.step(() => bootstrap.run(db));
    } catch (err) {
      if (err instanceof EngineBootStoppedError) throw err;
      logger.error({
        module: "engine",
        action: "bootstrap.probe_failed",
        msg: "first-run bootstrap probe failed (non-fatal)",
        ...errorFields(err),
      });
    }

    const boss = await lifetime.acquire(
      () =>
        bootPhase("queue_start", () => startBoss({ connectionString: getConfig().database.url })),
      (resource) =>
        resource.stop({ close: false, graceful: true, timeout: SHUTDOWN_DRAIN_TIMEOUT_MS }),
      () => stopBoss(SHUTDOWN_DRAIN_TIMEOUT_MS),
    );
    recordBootConsumer("queue");
    await lifetime.step(() =>
      bootPhase("queue_handlers", () => registerAllHandlers({ boss, db, chatRegistry })),
    );

    try {
      const { hydrateChatRegistry } = await lifetime.step(() => import("./chat/hydrate.ts"));
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

    try {
      const overrideThresholdMs = getConfig().queue.crash_recovery_threshold_ms;
      const { recovered, reconciled_steps } = await lifetime.step(() =>
        recoverCrashedExecutions(db, overrideThresholdMs > 0 ? { overrideThresholdMs } : {}),
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
      () => startCrashRecoveryMonitor(db),
      (monitor) => monitor.stop(),
    );
    recordBootConsumer("crash-recovery");

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

    lifetime.background(
      () =>
        warmEmbeddings()
          .then((ready) =>
            logger.info({
              module: "embeddings",
              action: "warm.complete",
              msg: ready
                ? "embedding model warm — semantic retrieval active"
                : "embedding model unavailable — retrieval uses FTS",
              available: ready,
            }),
          )
          .catch((err) =>
            logger.warn({
              module: "embeddings",
              action: "warm.failed",
              msg: "embedding warm-up failed (non-fatal); retrieval uses FTS",
              ...errorFields(err),
            }),
          ),
      (error) =>
        logger.warn({
          module: "embeddings",
          action: "warm.failed",
          msg: "embedding warm-up failed",
          ...errorFields(error),
        }),
    );

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

    lifetime.assertRunning();
    const reconciler = new SchedulerReconciler({ boss, db });
    installEngineScheduler(lifetime, reconciler, {
      completed: () =>
        logger.info({
          module: "scheduler",
          action: "first_sweep.completed",
          msg: "initial scheduler sweep completed",
        }),
      failed: (error) => {
        void shutdown("boot_failure", 1);
        logger.error({
          module: "scheduler",
          action: "first_sweep.failed",
          msg: "initial scheduler sweep failed",
          ...errorFields(error),
        });
      },
    });
    recordBootConsumer("scheduler");
    logger.info({
      module: "scheduler",
      action: "consumer.installed",
      msg: "scheduler consumer installed; first sweep pending",
    });

    const restartReminderTimer = setInterval(
      () => {
        if (lifetime.stopping) return;
        lifetime.background(
          async () => {
            try {
              const { emitRequiresRestartPendingIfAny } = await import("./config/loader.ts");
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
      },
      5 * 60 * 1000,
    );
    lifetime.registerStop(() => clearInterval(restartReminderTimer));
    if (typeof restartReminderTimer.unref === "function") restartReminderTimer.unref();

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
      const { operatorTenant } = await lifetime.step(() => import("./rbac/operator.ts"));
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

    if (cfg.operations.seed_skills_at_boot) {
      lifetime.background(
        async () => {
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
            const outcomes = await applySkillSeedsForAllTenants(loaded.skills, db);
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
          } finally {
            if (!lifetime.stopping) await seedKnowledgeAtBoot(db);
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
    } else {
      lifetime.background(
        () => seedKnowledgeAtBoot(db),
        (error) =>
          logger.error({
            module: "engine",
            action: "knowledge.seed.failed",
            msg: "background knowledge seed failed",
            ...errorFields(error),
          }),
      );
    }

    lifetime.assertRunning();
    const app = createApp({ db, chatRegistry });
    const port = getConfig().server.port;
    recordBootConsumer("http_server");

    const opts = engineServeOptions(port);
    await lifetime.acquire(
      () =>
        serve({
          fetch: (request, env) => {
            if (lifetime.stopping) return new Response("Service unavailable", { status: 503 });
            return lifetime.handleRequest(() => app.fetch(request, env));
          },
          port: opts.port,
          hostname: opts.hostname,
        }),
      (server) => {
        httpShutdown = beginHttpShutdown(server);
      },
    );

    logger.info({
      module: "engine",
      action: "ready",
      msg: `engine listening on http://${opts.hostname}:${port}`,
      version: OPENAPI_INFO.version,
      port,
      hostname: opts.hostname,
      public_base_url: getConfig().server.public_base_url || null,
      rss_mb: Math.round((readMemoryUsage().rss / (1024 * 1024)) * 10) / 10,
    });

    stopBootHeartbeat();
    await lifetime.acquire(
      () =>
        startMemorySampler({
          poolStats: () => {
            const pool = getPool();
            return {
              total: pool.totalCount,
              idle: pool.idleCount,
              waiting: pool.waitingCount,
            };
          },
        }),
      (stop) => stop(),
    );
    await lifetime.acquire(startEventLoopLagMonitor, (stop) => stop());

    await lifetime.step(emitBootComplete);

    void listener;

    await new Promise<void>(() => {});
  } catch (error) {
    if (!(error instanceof EngineBootStoppedError) && !lifetime.stopping)
      logger.fatal({
        module: "engine",
        action: "boot.failed",
        msg: "engine failed to boot",
        ...errorFields(error),
      });
    await shutdown(
      "boot_failure",
      error instanceof EngineBootStoppedError ? shutdownExitCode("signal") : 1,
    );
  }
}

async function loadConfigAndReconfigureLogger() {
  const { loadConfig, getConfig } = await import("./config/loader.ts");
  await loadConfig();
  const cfg = getConfig();
  const { reconfigureLogger, reconfigureObservability } = await import("./logging/logger.ts");
  reconfigureLogger({ level: cfg.log.level, format: cfg.log.format });
  reconfigureObservability({
    field_truncation_chars: cfg.observability.field_truncation_chars,
    service_name: cfg.observability.otlp.service_name,
    deployment_environment: cfg.observability.deployment_environment,
  });
  return cfg;
}
async function runMigrateOnce(): Promise<void> {
  const cfg = await loadConfigAndReconfigureLogger();
  await runMigrationsFromUrl(cfg.database.url);
}

async function runSeedOnce(): Promise<void> {
  const cfg = await loadConfigAndReconfigureLogger();
  await runMigrationsFromUrl(cfg.database.url);
  const db = getDb();
  const result = await seedAtBoot(db);
  for (const key of result.issued_keys) {
    printIssuedKey(key, { source: "cli" });
  }
  await closeDb();
}

async function main(): Promise<void> {
  if (process.argv.includes(VERSION_FLAG)) {
    process.stdout.write(`${OPENAPI_INFO.version}\n`);
    process.exit(0);
  }
  if (process.argv.includes(HELP_FLAG)) {
    const { engineHelp } = await import("./help-text.ts");
    process.stdout.write(engineHelp(OPENAPI_INFO.version));
    process.exit(0);
  }

  if (process.argv.includes(CHECK_UPDATE_FLAG)) {
    const info = await checkForUpdate(defaultUpdaterConfig("engine", OPENAPI_INFO.version), true);
    if (info) {
      process.stdout.write(`engine: update available ${OPENAPI_INFO.version} → ${info.version}\n`);
      process.exit(0);
    }
    process.stdout.write(`engine: already at latest version ${OPENAPI_INFO.version}\n`);
    process.exit(0);
  }

  if (process.argv.includes(SELF_UPDATE_FLAG)) {
    const { runSelfUpdate } = await import("./self-update.ts");
    try {
      await runSelfUpdate();
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `engine: update failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  if (process.argv.includes(ROLLBACK_FLAG)) {
    const { z } = await import("zod");
    const { runRollback } = await import("./self-update.ts");
    const RollbackTargetSchema = z
      .string()
      .min(1, "--to= must not be empty")
      .regex(/^[A-Za-z0-9._+-]+$/, "--to= must look like a version (e.g. 4.2.0)");
    const toArg = process.argv.find((a) => a.startsWith("--to="));
    let target: string | "previous" = "previous";
    if (toArg) {
      const raw = toArg.slice("--to=".length);
      const parsed = RollbackTargetSchema.safeParse(raw);
      if (!parsed.success) {
        process.stderr.write(
          `engine: invalid --to= value '${raw}': ${parsed.error.issues.map((i) => i.message).join("; ")}\n`,
        );
        process.exit(2);
      }
      target = parsed.data;
    }
    try {
      await runRollback(target);
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `engine: rollback failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  const preflightCli = await import("./preflight/cli-entry.ts");
  if (preflightCli.isPreflightInvocation(process.argv)) {
    await preflightCli.runPreflightCliOrExit(process.argv.slice(2), loadConfigAndReconfigureLogger);
    return;
  }

  if (process.argv.includes(MIGRATE_FLAG)) {
    await withContext(
      {
        trace_id: newTraceId(),
        tenant_id: SYSTEM_TENANT_ID,
        request_source: "cli",
        actor_id: "migrate",
      },
      async () => {
        try {
          await runMigrateOnce();
          process.exit(0);
        } catch (err) {
          logger.fatal({
            module: "engine",
            action: "migrate.cli_failed",
            msg: "engine --migrate failed",
            ...errorFields(err),
          });
          process.exit(1);
        }
      },
    );
    return;
  }

  if (process.argv.includes(ISSUE_ADMIN_KEY_FLAG)) {
    await withContext(
      {
        trace_id: newTraceId(),
        tenant_id: SYSTEM_TENANT_ID,
        request_source: "cli",
        actor_id: "issue-admin-key",
      },
      async () => {
        try {
          const { issueAdminKey, parseIssueAdminKeyArgs, formatIssuedKeyBanner } = await import(
            "./db/issue-admin-key.ts"
          );
          await loadConfigAndReconfigureLogger();
          const { tenantSlug } = parseIssueAdminKeyArgs(process.argv.slice(2));
          const issued = await issueAdminKey({ tenantSlug });
          process.stdout.write(`${formatIssuedKeyBanner(issued)}\n`);
          await closeDb();
          process.exit(0);
        } catch (err) {
          logger.fatal({
            module: "engine",
            action: "issue_admin_key.cli_failed",
            msg: "engine --issue-admin-key failed",
            ...errorFields(err),
          });
          process.exit(1);
        }
      },
    );
    return;
  }

  if (process.argv.includes(SET_OPERATOR_TENANT_FLAG)) {
    await withContext(
      {
        trace_id: newTraceId(),
        tenant_id: SYSTEM_TENANT_ID,
        request_source: "cli",
        actor_id: "set-operator-tenant",
      },
      async () => {
        try {
          const { parseSetOperatorTenantArgs, setOperatorTenantFromUrl } = await import(
            "./db/set-operator-tenant.ts"
          );
          const cfg = await loadConfigAndReconfigureLogger();
          const { tenantSlug } = parseSetOperatorTenantArgs(process.argv.slice(2));
          const assigned = await setOperatorTenantFromUrl(cfg.database.url, tenantSlug);
          process.stdout.write(
            `engine operator workspace: ${assigned.tenant_slug} (${assigned.tenant_id})\n`,
          );
          await closeDb();
          process.exit(0);
        } catch (err) {
          logger.fatal({
            module: "engine",
            action: "set_operator_tenant.cli_failed",
            msg: "engine --set-operator-tenant failed",
            ...errorFields(err),
          });
          process.exit(1);
        }
      },
    );
    return;
  }

  if (process.argv.includes(TOKEN_EXCHANGE_FLAG)) {
    const { runTokenExchangeCli } = await import("./auth/oauth/token-exchange-cli.ts");
    await runTokenExchangeCli(process.argv.slice(2), loadConfigAndReconfigureLogger);
    return;
  }

  if (process.argv.includes(SEED_FLAG)) {
    await withContext(
      {
        trace_id: newTraceId(),
        tenant_id: SYSTEM_TENANT_ID,
        request_source: "cli",
        actor_id: "seed",
      },
      async () => {
        try {
          await runSeedOnce();
          process.exit(0);
        } catch (err) {
          logger.fatal({
            module: "engine",
            action: "seed.cli_failed",
            msg: "engine --seed failed",
            ...errorFields(err),
          });
          process.exit(1);
        }
      },
    );
    return;
  }

  const isSmoke = process.argv.includes(SMOKE_FLAG);

  await withContext(
    {
      trace_id: newTraceId(),
      tenant_id: SYSTEM_TENANT_ID,
      request_source: "cli",
      actor_id: "boot",
    },
    async () => {
      if (isSmoke) {
        const { runSmoke } = await import("./smoke.ts");
        await runSmoke();
        process.exit(0);
      }
      await runServer();
    },
  );
}

main().catch((err) => {
  logger.fatal({
    module: "engine",
    action: "boot.failed",
    msg: "engine failed to boot",
    ...errorFields(err),
  });
  process.exit(1);
});
