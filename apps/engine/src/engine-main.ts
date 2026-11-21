import { checkForUpdate, defaultUpdaterConfig } from "@cli-core/updater.ts";
import { SYSTEM_TENANT_ID } from "./audit/index.ts";
import { ChatAdapterRegistry } from "./chat/registry.ts";
import { SkCliAdapter } from "./chat/sk-cli/adapter.ts";
import {
  createEngineShutdown,
  runBootSeeds,
  startHttp,
  startScheduler,
  startWorker,
} from "./composition/index.ts";
import { assertCryptoKeyOrExit } from "./crypto/index.ts";
import { closeDb, type Db, getDb, getPool } from "./db/client.ts";
import { detectDrift, runMigrationsFromUrl } from "./db/migrate.ts";
import { printIssuedKey, seedAtBoot } from "./db/seed.ts";
import { EngineBootLifetime, EngineBootStoppedError } from "./engine-boot-lifetime.ts";
import { envSnapshot, readEnv, validateEnv } from "./env.ts";
import { getScanner, NoopScanner } from "./files/scanner.ts";
import { setHealthState } from "./http/health-state.ts";
import { OPENAPI_INFO } from "./http/openapi.ts";
import { localWorkspaceFor } from "./identity/local-workspace.ts";
import { newTraceId, withContext } from "./logging/context.ts";
import { errorFields, logger } from "./logging/logger.ts";
import {
  runtimeDiagnosticEvent,
  runtimeDiagnosticsEnabled,
} from "./observability/runtime-diagnostics.ts";
import {
  bootPhase,
  startBootHeartbeat,
  startEventLoopLagMonitor,
  startMemorySampler,
} from "./observability/runtime-telemetry.ts";
import { startTracing } from "./observability/tracing.ts";
import * as bootstrap from "./onboarding/bootstrap.ts";
import { shutdownExitCode } from "./runtime-config/restart.ts";
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
  validateEnv();
  const lifetime = new EngineBootLifetime();
  if (runtimeDiagnosticsEnabled()) {
    runtimeDiagnosticEvent("boot.diagnostics_requested");
    await lifetime.acquire(
      () => startEventLoopLagMonitor({ intervalMs: 250, thresholdMs: 50 }),
      (stop) => stop(),
    );
  }
  const engineShutdown = createEngineShutdown(lifetime);
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
    const localWorkspace = localWorkspaceFor(cfg.deployment.mode, envSnapshot());
    reconfigureLogger({ level: cfg.log.level, format: cfg.log.format });
    reconfigureObservability({
      field_truncation_chars: cfg.observability.field_truncation_chars,
      service_name: cfg.observability.otlp.service_name,
      deployment_environment: cfg.observability.deployment_environment,
    });
    recordBootConsumer("logger");
    if (getScanner() === NoopScanner && readEnv("NODE_ENV") === "production") {
      logger.info({
        module: "files",
        action: "scanner.noop_in_production",
        msg: "FileScanner is NoopScanner (accepted risk). Uploads are reported clean without AV scanning; tenant uploads are not a primary attack surface today.",
      });
    }

    const { runProductionPreflightOrExit } = await lifetime.step(
      () => import("./preflight/runner.ts"),
    );
    await lifetime.step(() => bootPhase("crypto_assert", () => assertCryptoKeyOrExit()));
    const db = getDb();
    engineShutdown.attachDatabase(db);
    const { assertVaultMasterKey, initializeRuntimeConfig, pinVaultMasterKey } =
      await lifetime.step(() => import("./runtime-config/service.ts"));
    const { RuntimeConfigCoordinator } = await lifetime.step(
      () => import("./runtime-config/coordinator.ts"),
    );
    const coordinator = new RuntimeConfigCoordinator(db, OPENAPI_INFO.version);
    engineShutdown.attachRuntimeConfig(coordinator);
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

    if (getConfig().operations.update_check_enabled && !localWorkspace)
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

    await reportMigrationDrift(db, lifetime);

    try {
      if (!localWorkspace) await lifetime.step(() => bootstrap.run(db));
    } catch (err) {
      if (err instanceof EngineBootStoppedError) throw err;
      logger.error({
        module: "engine",
        action: "bootstrap.probe_failed",
        msg: "first-run bootstrap probe failed (non-fatal)",
        ...errorFields(err),
      });
    }

    const { boss } = await startWorker(db, {
      lifetime,
      chatRegistry,
      localWorkspace,
      recordBootConsumer,
    });
    startScheduler(db, {
      lifetime,
      boss,
      localWorkspace,
      onFirstSweepFailed: () => void engineShutdown.shutdown("boot_failure", 1),
      recordBootConsumer,
    });
    await runBootSeeds(db, { lifetime, seedSkills: cfg.operations.seed_skills_at_boot });
    await startHttp(db, {
      lifetime,
      chatRegistry,
      localWorkspace,
      shutdown: engineShutdown,
      recordBootConsumer,
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
    if (!runtimeDiagnosticsEnabled())
      await lifetime.acquire(startEventLoopLagMonitor, (stop) => stop());

    await lifetime.step(emitBootComplete);

    await new Promise<void>(() => {});
  } catch (error) {
    if (!(error instanceof EngineBootStoppedError) && !lifetime.stopping)
      logger.fatal({
        module: "engine",
        action: "boot.failed",
        msg: "engine failed to boot",
        ...errorFields(error),
      });
    await engineShutdown.shutdown(
      "boot_failure",
      error instanceof EngineBootStoppedError ? shutdownExitCode("signal") : 1,
    );
  }
}

async function reportMigrationDrift(db: Db, lifetime: EngineBootLifetime): Promise<void> {
  try {
    const drift = await lifetime.step(() => detectDrift(db));
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
