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
import { startAbortMonitor } from "./execution/index.ts";
import { recoverCrashedExecutions, startCrashRecoveryMonitor } from "./execution/recovery.ts";
import { reapOrphanedWaits } from "./execution/wait-reaper.ts";
import { getScanner, NoopScanner } from "./files/scanner.ts";
import { setHealthState } from "./http/health-state.ts";
import { engineServeOptions } from "./http/listen-hostname.ts";
import { OPENAPI_INFO } from "./http/openapi.ts";
import { createApp } from "./http/server.ts";
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
const TOKEN_EXCHANGE_FLAG = "--token-exchange";
const VERSION_FLAG = "--version";
const HELP_FLAG = "--help";
async function runServer(): Promise<void> {
  const stopBootHeartbeat = startBootHeartbeat();

  const { loadConfig, getConfig, recordBootConsumer, emitBootComplete } = await import(
    "./config/loader.ts"
  );
  const { reconfigureLogger, reconfigureObservability } = await import("./logging/logger.ts");
  await bootPhase("config_load", () => loadConfig());
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

  const { runProductionPreflightOrExit } = await import("./preflight/runner.ts");
  await bootPhase("preflight", () => runProductionPreflightOrExit(getDb(), cfg));

  await bootPhase("crypto_assert", () => assertCryptoKeyOrExit());
  const db = getDb();

  const chatRegistry = new ChatAdapterRegistry();

  chatRegistry.registerFallback("sk_cli", new SkCliAdapter(db));

  try {
    await bootPhase("migrations", () => runMigrationsFromUrl(cfg.database.url));
  } catch (err) {
    logger.fatal({
      module: "engine",
      action: "migrate.failed_aborting_boot",
      msg: "embedded migrations failed; aborting boot to avoid running on a half-migrated schema",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  }

  const { assertSearchPathOrAbort } = await import("./db/assert-search-path-or-abort.ts");
  await bootPhase("search_path", assertSearchPathOrAbort);

  const { initializeRuntimeConfig } = await import("./runtime-config/service.ts");
  const { RuntimeConfigCoordinator } = await import("./runtime-config/coordinator.ts");
  await bootPhase("runtime_config", () => initializeRuntimeConfig(db, cfg));
  const runtimeConfigCoordinator = new RuntimeConfigCoordinator(db, OPENAPI_INFO.version);
  await bootPhase("runtime_config_coordinator", () => runtimeConfigCoordinator.start());
  const restart = await import("./runtime-config/restart.ts");
  await bootPhase("restart_outcome", () => restart.answerRestartRequestAtBoot(db));
  recordBootConsumer("runtime-config");

  const stopTracing = await startTracing();
  recordBootConsumer("tracing");

  if (getConfig().operations.update_check_enabled) startEngineUpdateCheck(OPENAPI_INFO.version);

  const { validateBootDependencies } = await import("./observability/boot-dependencies.ts");
  await bootPhase("boot_dependencies", () => validateBootDependencies(db));

  let drift: DriftReport | null = null;
  try {
    drift = await detectDrift(db);
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
    logger.error({
      module: "engine",
      action: "migrate.drift_check_failed",
      msg: "drift detection failed (non-fatal)",
      ...errorFields(err),
    });
  }

  try {
    await bootstrap.run(db);
  } catch (err) {
    logger.error({
      module: "engine",
      action: "bootstrap.probe_failed",
      msg: "first-run bootstrap probe failed (non-fatal)",
      ...errorFields(err),
    });
  }

  const boss = await bootPhase("queue_start", () =>
    startBoss({ connectionString: getConfig().database.url }),
  );
  recordBootConsumer("queue");
  await bootPhase("queue_handlers", () => registerAllHandlers({ boss, db, chatRegistry }));

  try {
    const { hydrateChatRegistry } = await import("./chat/hydrate.ts");
    const outcome = await hydrateChatRegistry(db, chatRegistry);
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
    logger.warn({
      module: "engine",
      action: "chat.hydrate.failed",
      msg: "chat-bridge hydration failed at boot; chat ingestion will return 503 until fixed",
      ...errorFields(err),
    });
  }

  try {
    const overrideThresholdMs = getConfig().queue.crash_recovery_threshold_ms;
    const { recovered, reconciled_steps } = await recoverCrashedExecutions(
      db,
      overrideThresholdMs > 0 ? { overrideThresholdMs } : {},
    );
    logger.info({
      module: "queue",
      action: "crash_recovery_complete",
      msg: "boot-time crash recovery sweep finished",
      recovered,
      reconciled_steps,
    });
  } catch (err) {
    logger.error({
      module: "queue",
      action: "crash_recovery_failed",
      msg: "boot-time crash recovery sweep failed (non-fatal)",
      ...errorFields(err),
    });
  }
  const crashRecoveryMonitor = startCrashRecoveryMonitor(db);
  recordBootConsumer("crash-recovery");

  try {
    const { reaped } = await reapOrphanedWaits(db, boss);
    if (reaped > 0) {
      logger.info({
        module: "execution",
        action: "wait_reaper.boot_complete",
        msg: "boot-time wait reaper finished",
        reaped,
      });
    }
  } catch (err) {
    logger.error({
      module: "execution",
      action: "wait_reaper.boot_failed",
      msg: "boot-time wait reaper failed (non-fatal)",
      ...errorFields(err),
    });
  }

  void warmEmbeddings()
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
    );

  const listener = await bootPhase("pubsub_listener", () =>
    startListener({ connectionString: getConfig().database.url, db }),
  );
  const abortMonitor = startAbortMonitor(db);

  const fanoutUnsubscribers: Array<() => void> = [];
  for (const channel of ["execution.status", "notification.emitted"] as const) {
    fanoutUnsubscribers.push(
      listener.on(channel, async (event) => {
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

  const reconciler = new SchedulerReconciler({ boss, db });
  await reconciler.start();
  recordBootConsumer("scheduler");

  const restartReminderTimer = setInterval(
    () => {
      void (async () => {
        try {
          const { emitRequiresRestartPendingIfAny } = await import("./config/loader.ts");
          await emitRequiresRestartPendingIfAny();
        } catch {}
      })();
    },
    5 * 60 * 1000,
  );
  if (typeof restartReminderTimer.unref === "function") restartReminderTimer.unref();

  try {
    const seedResult = await seedAtBoot(db);
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
  } catch (err) {
    logger.error({
      module: "engine",
      action: "seed.at_boot_failed",
      msg: "boot-time seed failed (non-fatal); auth may degrade until next boot",
      ...errorFields(err),
    });
  }

  if (cfg.operations.seed_skills_at_boot) {
    void (async () => {
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
      }
    })();
  }

  void seedKnowledgeAtBoot(db);

  const app = createApp({ db, chatRegistry });
  const port = getConfig().server.port;
  recordBootConsumer("http_server");

  const opts = engineServeOptions(port);
  const server = serve({
    fetch: app.fetch,
    port: opts.port,
    hostname: opts.hostname,
  });

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
  const stopMemorySampler = startMemorySampler({
    poolStats: () => {
      const pool = getPool();
      return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
    },
  });
  const stopEventLoopLagMonitor = startEventLoopLagMonitor();

  await emitBootComplete();

  const SHUTDOWN_DRAIN_TIMEOUT_MS = 120_000;
  let shutting = false;
  const shutdown = async (
    signal: NodeJS.Signals | "restart",
    exitCode = restart.shutdownExitCode("signal"),
  ): Promise<void> => {
    if (shutting) return;
    shutting = true;
    setHealthState({ draining: true });
    stopMemorySampler();
    stopEventLoopLagMonitor();
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
      process.exit(restart.shutdownExitCode("timeout"));
    }, SHUTDOWN_DRAIN_TIMEOUT_MS + 20_000);
    (hardKill as unknown as { unref?: () => void }).unref?.();
    try {
      const httpShutdown = beginHttpShutdown(server);
      await reconciler.stop();
      for (const off of fanoutUnsubscribers) off();
      crashRecoveryMonitor.stop();
      abortMonitor.stop();
      await stopListener();
      await runtimeConfigCoordinator.stop();
      await stopBoss(SHUTDOWN_DRAIN_TIMEOUT_MS);
      httpShutdown.forceClose();
      const httpClosed = await httpShutdown.waitUntilClosed(1_000);
      if (!httpClosed) {
        logger.warn({
          module: "http",
          action: "shutdown.http_force_close_timeout",
          msg: "HTTP close callback remained pending after force-closing connections; continuing shutdown",
          timeout_ms: 1_000,
        });
      }
      try {
        await closeAllPools();
      } catch (err) {
        logger.warn({
          module: "engine",
          action: "shutdown.pg_pools_drain_failed",
          msg: "failed to drain postgres connector pools",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await closeDb();
      await stopTracing();
      logger.info({
        module: "engine",
        action: "shutdown.complete",
        msg: "graceful shutdown complete",
      });
    } catch (err) {
      logger.error({
        module: "engine",
        action: "shutdown.error",
        msg: "error during shutdown",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    clearTimeout(hardKill);
    process.exit(exitCode);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  restart.registerRestartTrigger(
    () => void shutdown("restart", restart.shutdownExitCode("restart")),
  );

  void listener;

  await new Promise<void>(() => {});
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
            error: err instanceof Error ? err.message : String(err),
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
            error: err instanceof Error ? err.message : String(err),
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
            error: err instanceof Error ? err.message : String(err),
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
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
