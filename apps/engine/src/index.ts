import { checkForUpdate, defaultUpdaterConfig } from "@cli-core/updater.ts";
import { serve } from "@hono/node-server";
import { SYSTEM_TENANT_ID } from "./audit/index.ts";
import { ChatAdapterRegistry } from "./chat/registry.ts";
import { closeAllPools } from "./connectors/drivers/postgres.ts";
import { assertCryptoKeyOrExit } from "./crypto/aes-gcm.ts";
import { closeDb, getDb } from "./db/client.ts";
import { type DriftReport, detectDrift, runMigrations } from "./db/migrate.ts";
import { printIssuedKey, seedAtBoot } from "./db/seed.ts";
import { recoverCrashedExecutions, resolveCrashRecoveryThresholdMs } from "./execution/recovery.ts";
import { reapOrphanedWaits } from "./execution/wait-reaper.ts";
import { setHealthState } from "./http/health-state.ts";
import { OPENAPI_INFO } from "./http/openapi.ts";
import { createApp } from "./http/server.ts";
import { newTraceId, withContext } from "./logging/context.ts";
import { errorFields, logger } from "./logging/logger.ts";
import { startTracing } from "./observability/tracing.ts";
import * as bootstrap from "./onboarding/bootstrap.ts";
import { startListener, stopListener } from "./pubsub/listener.ts";
import { startBoss, stopBoss } from "./queue/boss.ts";
import { registerAllHandlers } from "./queue/handlers/index.ts";
import { SchedulerReconciler } from "./scheduler/reconciler.ts";
import { applySkillSeedsForAllTenants, loadEmbeddedSkillSeeds } from "./skills/seed.ts";
import { startTunnelWsServer, type TunnelWsServerHandle } from "./tunnels/ws-server.ts";
import { setUpdateState } from "./update-state.ts";

const SMOKE_FLAG = "--smoke";
const SELF_UPDATE_FLAG = "--self-update";
const CHECK_UPDATE_FLAG = "--check-update";
const MIGRATE_FLAG = "--migrate";
const SEED_FLAG = "--seed";
const ISSUE_ADMIN_KEY_FLAG = "--issue-admin-key";

async function runSmoke(): Promise<void> {
  // Read raw process.env. Importing `./env.ts` would trigger the lazy
  // EnvSchema parse on first property access — and the smoke binary
  // must run without DATABASE_URL/MASTER_KEY (matrix smoke step in
  // release.yml only sets the bare minimum, and operators sanity-check
  // a fresh download with `engine --smoke` before configuring anything).
  const node_env = process.env.NODE_ENV ?? "development";
  const port = Number(process.env.PORT ?? "3000");
  logger.info({
    module: "engine",
    action: "smoke.started",
    msg: "smoke mode: validating logger + audit + redaction",
    node_env,
    port,
  });

  // System-level startup: logger.info is the durable record.
  // `audit_log.tenant_id` is a NOT NULL uuid FK, so a synthetic
  // "system" value would fail the insert. If we ever need a real
  // audit row for startup, a dedicated `system_audit_log` without
  // a tenant column is the right shape — tracked separately.

  logger.info({
    module: "engine",
    action: "redaction.test",
    msg: "this line contains a secret that must be redacted",
    headers: {
      authorization: "Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      cookie: "session=abc123",
    },
    body_preview: "token=wf_live_abcdef1234567890",
    note: "Bearer should be stripped inside this free-form string too",
  });

  logger.info({
    module: "engine",
    action: "smoke.completed",
    msg: "smoke mode: exit 0",
  });
}

async function runServer(): Promise<void> {
  // Phase 1 logger is already live (hardcoded defaults). Load the
  // config file before any subsystem reads it; reconfigure the logger
  // immediately so subsequent boot logs honor the operator's settings.
  const { loadConfig, getConfig, recordBootConsumer, emitBootComplete } = await import(
    "./config/loader.ts"
  );
  const { reconfigureLogger } = await import("./logging/logger.ts");
  await loadConfig();
  const cfg = getConfig();
  reconfigureLogger({ level: cfg.log.level, format: cfg.log.format });
  recordBootConsumer("logger");

  // Surfaces a bad MASTER_KEY in the boot log, before any request can
  // reach an encrypt/decrypt path. Pre-fix this lived as a top-level
  // call in crypto/aes-gcm.ts but that fired on every binary import,
  // breaking arg-only flags like --smoke / --version.
  assertCryptoKeyOrExit();
  const db = getDb();

  // Non-blocking update check — fire and forget
  if (process.env.NO_UPDATE_CHECK !== "1")
    checkForUpdate(defaultUpdaterConfig("engine", OPENAPI_INFO.version))
      .then((info) => {
        if (info) {
          setUpdateState({ update_available: true, latest_version: info.version });
          logger.warn({
            module: "engine",
            action: "update.available",
            msg: `update available: ${info.version}`,
            current_version: OPENAPI_INFO.version,
            latest_version: info.version,
          });
        } else {
          setUpdateState({ update_available: false, latest_version: OPENAPI_INFO.version });
        }
      })
      .catch(() => {
        /* silent — never block engine startup */
      });

  // Shared chat adapter registry — both the HTTP routes and the
  // outbound fanout worker resolve chat adapters out of this single
  // instance so notification dispatch can find adapters that were
  // registered via the /chat/install flow.
  const chatRegistry = new ChatAdapterRegistry();

  // OpenTelemetry tracer — bootstrap before anything that might emit
  // spans so the LLM `experimental_telemetry` calls, pg-boss handlers,
  // and HTTP routes all land in the same trace context. No-op when no
  // exporter env vars are set.
  const stopTracing = await startTracing();
  recordBootConsumer("tracing");

  // Apply embedded migrations BEFORE any subsystem touches a table.
  // Issue #149: this used to be a separate `migrate` compose container
  // that could ship a different lineage than the engine binary, which
  // is exactly how prod ended up with 27 unknown migration rows. The
  // migration set is now compiled into this binary via the
  // `embed.macro.ts` Bun macro, so engine + migrations are one
  // bit-for-bit artifact. **Failure here is fatal** — a half-migrated
  // schema would make every downstream subsystem misbehave the way
  // wait_reaper / docs_refresh / skills.seed did before this fix.
  try {
    await runMigrations(db);
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

  // Drift detection — read-only. If the DB carries migration rows whose
  // hash isn't in this binary, the schema state was set by a different
  // engine lineage. We log loudly and surface the flag in /v1/health
  // (operators see it on the dashboard), but boot continues — the
  // existing schema may still satisfy this binary's expectations.
  let drift: DriftReport | null = null;
  try {
    drift = await detectDrift(db);
    if (drift.unknown_in_db.length > 0) {
      logger.warn({
        module: "engine",
        action: "migrate.drift_detected",
        msg: "DB carries migration rows not present in this binary",
        unknown_count: drift.unknown_in_db.length,
        first_hashes: drift.unknown_in_db.slice(0, 10).map((r) => r.hash),
      });
    }
    setHealthState({ schema_drift: drift.unknown_in_db.length > 0 });
  } catch (err) {
    logger.error({
      module: "engine",
      action: "migrate.drift_check_failed",
      msg: "drift detection failed (non-fatal)",
      ...errorFields(err),
    });
  }

  // First-run bootstrap probe.  Self-detects an empty `tenants` table +
  // unset post-bootstrap sentinel, mints a one-time token, and prints a
  // copy-paste `sk init --token <token>` banner.  Once the operator
  // POSTs `/v1/setup`, the sentinel flips and this becomes a no-op on
  // every subsequent boot.  Wrapped so a transient DB error never
  // blocks the engine from coming up — the next boot retries.
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

  // Start pg-boss + register handlers before the HTTP server so enqueue
  // requests hitting the first byte always find a live boss.
  const boss = await startBoss({ connectionString: getConfig().database.url });
  recordBootConsumer("queue");
  await registerAllHandlers({ boss, db, chatRegistry });

  // Crash-recovery sweep: promote any execution stuck in `running` past
  // its workflow's `timeout_ms × 1.5` grace window into `timed_out`.
  // Wrapped in try/catch so a sweep failure (e.g. transient DB blip)
  // never blocks engine startup — the next boot will retry.
  try {
    const overrideThresholdMs = resolveCrashRecoveryThresholdMs(
      process.env.SK_EXECUTION_CRASH_RECOVERY_THRESHOLD_MS,
    );
    const { recovered } = await recoverCrashedExecutions(
      db,
      overrideThresholdMs ? { overrideThresholdMs } : {},
    );
    logger.info({
      module: "queue",
      action: "crash_recovery_complete",
      msg: "boot-time crash recovery sweep finished",
      recovered,
    });
  } catch (err) {
    logger.error({
      module: "queue",
      action: "crash_recovery_failed",
      msg: "boot-time crash recovery sweep failed (non-fatal)",
      ...errorFields(err),
    });
  }

  // #48: reap orphaned wait checkpoints. Re-enqueues `execution.run`
  // for every row in `workflow_waits` (`sendAfter:sleep_until_ts` for
  // future deadlines, immediate for overdue ones), then drops the
  // checkpoint row. Each reap emits `WAIT_COMPLETED { reason:
  // "recovered" }` so the operator can correlate against the original
  // `WAIT_STARTED` entry.
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

  // Pub/sub listener — catch-up first, then LISTEN.
  const listener = await startListener({ connectionString: getConfig().database.url, db });

  // Cron reconciler — sync workflows_schedules -> pg-boss schedules.
  const reconciler = new SchedulerReconciler({ boss, db });
  await reconciler.start();
  recordBootConsumer("scheduler");

  // Periodic warn for pending requiresRestart leaves — operator-grade
  // reminder that a setConfigKey call has landed but the engine
  // hasn't been restarted to pick it up yet. 5-minute cadence lines
  // up with the ops cadence on the docs/observability dashboards.
  const restartReminderTimer = setInterval(
    () => {
      void (async () => {
        try {
          const { emitRequiresRestartPendingIfAny } = await import("./config/loader.ts");
          await emitRequiresRestartPendingIfAny();
        } catch {
          /* logger module not loaded yet */
        }
      })();
    },
    5 * 60 * 1000,
  );
  // Don't keep the event loop alive on this timer alone.
  if (typeof restartReminderTimer.unref === "function") restartReminderTimer.unref();

  // RBAC essentials + (NODE_ENV-gated) dev fixtures. Idempotent.
  // Failure is non-fatal: a transient DB blip might keep auth in a
  // degraded state, but the next boot retries. Migrations have already
  // run by this point, so the schema is guaranteed to match the seed
  // queries — the #149 "skill upsert vs. schema mismatch" path is gone.
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

  // Skill-seed pipeline. Loads the markdown skill library embedded in
  // this binary and upserts each seeded skill into every tenant.
  // Idempotent + content-hash-gated so unchanged seeds are a no-op on
  // subsequent boots. Runs in the background so a large skill catalog
  // never delays serving the first HTTP request.
  if (process.env.SK_SEED_SKILLS !== "0") {
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

  const app = createApp({ db, chatRegistry });
  const port = getConfig().server.port;
  recordBootConsumer("http_server");

  const server = serve({ fetch: app.fetch, port });

  logger.info({
    module: "engine",
    action: "ready",
    msg: `engine listening on http://0.0.0.0:${port}`,
    port,
    public_base_url: getConfig().server.public_base_url || null,
  });

  // boot.complete: every subsystem above (logger, queue, http_server,
  // tracing if started, …) called recordBootConsumer. Emit one summary
  // line so an operator tailing the boot log can confirm the
  // loader → consumer chain is fully wired.
  await emitBootComplete();

  // Tunnel WebSocket listener — separate Bun.serve listener (Bun runtime
  // required) so tunnel agents have a place to connect. Defaults to PORT+1
  // when server.tunnel_port is not set.
  let tunnelWs: TunnelWsServerHandle | null = null;
  try {
    tunnelWs = startTunnelWsServer({
      db,
      port: getConfig().server.tunnel_port ?? port + 1,
    });
    logger.info({
      module: "engine",
      action: "tunnels.ws.started",
      msg: `tunnel ws listening on ${tunnelWs.url}`,
      port: tunnelWs.port,
    });
  } catch (err) {
    logger.warn({
      module: "engine",
      action: "tunnels.ws.start_failed",
      msg: "tunnel ws server failed to start (Bun runtime required)",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // See note above — we skip the audit row for system startup
  // because audit_log.tenant_id is NOT NULL and we intentionally
  // do not pin startup events to any tenant. logger.info above
  // already captures the `engine.ready` line.

  // Graceful shutdown. Drain pg-boss, stop reconciler, close listener,
  // close HTTP, close pg pool. 15s hard-kill fallback.
  let shutting = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutting) return;
    shutting = true;
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
      process.exit(1);
    }, 15_000);
    (hardKill as unknown as { unref?: () => void }).unref?.();
    try {
      await reconciler.stop();
      await stopBoss(10_000);
      await stopListener();
      if (tunnelWs) {
        try {
          await tunnelWs.stop();
        } catch (err) {
          logger.warn({
            module: "engine",
            action: "tunnels.ws.stop_failed",
            msg: "failed to stop tunnel ws server",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await new Promise<void>((resolve) => {
        (server as unknown as { close?: (cb: () => void) => void }).close?.(() => resolve()) ??
          resolve();
      });
      // Drain every postgres-driver connection pool so the database
      // doesn't observe abandoned connections after the engine exits.
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
      // Flush + shutdown the OTel tracer last so any shutdown-related
      // spans land at the exporter. Best-effort — exporter failure
      // here cannot stop process exit.
      await stopTracing();
    } catch (err) {
      logger.error({
        module: "engine",
        action: "shutdown.error",
        msg: "error during shutdown",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    clearTimeout(hardKill);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Touch the listener so the unused-var linter is happy.
  void listener;

  // Park the main task — the http server keeps the process alive on its own.
  await new Promise<void>(() => {});
}

/**
 * Bootstrap shared by `runServer`, `runMigrateOnce`, and `runSeedOnce`.
 *
 * `config/loader.ts` is imported dynamically so the smoke / version
 * argv-only paths don't trigger the lazy `EnvSchema` parse that fires
 * on first property access. `logging/logger.ts` is dynamic for the
 * same reason — the configured level/format only matters once
 * config is loaded. (Review R2-S2: hoisted out of the per-flag
 * helpers so the dynamic-import pattern lives in one place.)
 */
async function loadConfigAndReconfigureLogger(): Promise<void> {
  const { loadConfig, getConfig } = await import("./config/loader.ts");
  await loadConfig();
  const cfg = getConfig();
  const { reconfigureLogger } = await import("./logging/logger.ts");
  reconfigureLogger({ level: cfg.log.level, format: cfg.log.format });
}

async function runMigrateOnce(): Promise<void> {
  await loadConfigAndReconfigureLogger();
  const db = getDb();
  await runMigrations(db);
  await closeDb();
}

async function runSeedOnce(): Promise<void> {
  await loadConfigAndReconfigureLogger();
  const db = getDb();
  // Migrations run first — operators expect `engine --seed` to be safe
  // against a fresh DB the same way the boot path is.
  await runMigrations(db);
  const result = await seedAtBoot(db);
  for (const key of result.issued_keys) {
    printIssuedKey(key, { source: "cli" });
  }
  await closeDb();
}

async function main(): Promise<void> {
  // --check-update: check for updates without installing, exit.
  if (process.argv.includes(CHECK_UPDATE_FLAG)) {
    const info = await checkForUpdate(defaultUpdaterConfig("engine", OPENAPI_INFO.version), true);
    if (info) {
      process.stdout.write(`engine: update available ${OPENAPI_INFO.version} → ${info.version}\n`);
      process.exit(0);
    }
    process.stdout.write(`engine: already at latest version ${OPENAPI_INFO.version}\n`);
    process.exit(0);
  }

  // --self-update: download newer binary, replace, exit.
  // Checked before smoke/server since it doesn't need DATABASE_URL.
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

  // --migrate: apply embedded migrations and exit. Useful for blue/green
  // deploys where the operator wants a pre-flight check without booting
  // the HTTP listener. The default boot path also runs migrations, so
  // this flag is a convenience, not a requirement.
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

  // --issue-admin-key [--tenant <slug>]: mint a fresh admin API key
  // against an existing tenant + admin user, print the plaintext once,
  // exit. Lets operators rotate or bootstrap the verify/diagnostics
  // key on the droplet without needing the source repo + bun runtime
  // (e.g. `sudo -u subkit /usr/local/bin/engine --issue-admin-key`).
  // Does NOT run migrations or seed — safe on a live database.
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

  // --seed: idempotent boot-time seed (RBAC + dev fixtures in non-prod).
  // Replaces the deleted `bun run db:seed` script. Runs migrations
  // first to keep parity with the default boot path.
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
