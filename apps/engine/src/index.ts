import { checkForUpdate, defaultUpdaterConfig } from "@cli-core/updater.ts";
import { serve } from "@hono/node-server";
import { ChatAdapterRegistry } from "./chat/registry.ts";
import { closeAllPools } from "./connectors/drivers/postgres.ts";
import { closeDb, getDb } from "./db/client.ts";
import { recoverCrashedExecutions, resolveCrashRecoveryThresholdMs } from "./execution/recovery.ts";
import { OPENAPI_INFO } from "./http/openapi.ts";
import { createApp } from "./http/server.ts";
import { newTraceId, withContext } from "./logging/context.ts";
import { logger } from "./logging/logger.ts";
import { startTracing } from "./observability/tracing.ts";
import { startListener, stopListener } from "./pubsub/listener.ts";
import { startBoss, stopBoss } from "./queue/boss.ts";
import { registerAllHandlers } from "./queue/handlers/index.ts";
import { seedBuiltinRolesAndPermissions } from "./rbac/seed.ts";
import { SchedulerReconciler } from "./scheduler/reconciler.ts";
import { applySkillSeedsForAllTenants, loadSkillSeedsFromDisk } from "./skills/seed.ts";
import { startTunnelWsServer, type TunnelWsServerHandle } from "./tunnels/ws-server.ts";
import { setUpdateState } from "./update-state.ts";

const SMOKE_FLAG = "--smoke";
const SELF_UPDATE_FLAG = "--self-update";
const CHECK_UPDATE_FLAG = "--check-update";

async function runSmoke(): Promise<void> {
  const { env } = await import("./env.ts");
  logger.info({
    module: "engine",
    action: "smoke.started",
    msg: "smoke mode: validating logger + audit + redaction",
    node_env: env.NODE_ENV,
    port: env.PORT,
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
  const { env, validateLlmEnvironment } = await import("./env.ts");
  validateLlmEnvironment(process.env, { requireConfigured: true });
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

  // Engine-essential seed: RBAC permission catalog + 6 builtin roles.
  // Idempotent and fast (<200ms). Running this on every startup
  // removes the runtime dependency on the separate `seed` compose
  // container — auth subsystem now boots without it. Wrapped so a
  // transient DB blip never blocks engine startup; the next boot
  // retries.
  try {
    await seedBuiltinRolesAndPermissions(db);
    logger.info({
      module: "engine",
      action: "rbac.seed_applied",
      msg: "RBAC roles + permissions seeded on startup",
    });
  } catch (err) {
    logger.error({
      module: "engine",
      action: "rbac.seed_failed",
      msg: "RBAC seed failed; engine will boot but auth may degrade",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start pg-boss + register handlers before the HTTP server so enqueue
  // requests hitting the first byte always find a live boss.
  const boss = await startBoss({ connectionString: env.DATABASE_URL });
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
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Pub/sub listener — catch-up first, then LISTEN.
  const listener = await startListener({ connectionString: env.DATABASE_URL, db });

  // Cron reconciler — sync workflows_schedules -> pg-boss schedules.
  const reconciler = new SchedulerReconciler({ boss, db });
  await reconciler.start();

  // Skill-seed pipeline. Loads the markdown skill library bundled under
  // conversations/seed/skills/ and upserts each seeded skill into every
  // tenant. Idempotent + content-hash-gated so unchanged seeds are a no-op
  // on subsequent boots. Runs in the background so a large skill catalog
  // never delays serving the first HTTP request.
  if (process.env.SK_SEED_SKILLS !== "0") {
    void (async () => {
      try {
        const loaded = await loadSkillSeedsFromDisk();
        logger.info({
          module: "skills.seed",
          action: "seed.resolved_dir",
          msg: "skill seed directory resolved",
          resolved_dir: loaded.resolved_dir,
          searched_dirs: loaded.searched_dirs,
          missing_dirs: loaded.missing_dirs,
        });
        if (loaded.errors.length > 0) {
          logger.warn({
            module: "skills.seed",
            action: "seed.parse_errors",
            msg: "some skill seeds failed to parse",
            errors: loaded.errors.map((e) => ({ file: e.file, code: e.code })),
          });
        }
        if (loaded.skills.length === 0) {
          logger.info({
            module: "skills.seed",
            action: "seed.empty",
            msg: "no skill seeds found on disk; skipping",
            resolved_dir: loaded.resolved_dir,
            searched_dirs: loaded.searched_dirs,
            missing_dirs: loaded.missing_dirs,
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
          ...totals,
        });
      } catch (err) {
        logger.error({
          module: "skills.seed",
          action: "seed.failed",
          msg: "skill seed apply failed (non-fatal)",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  const app = createApp({ db, chatRegistry });
  const port = env.PORT;

  const server = serve({ fetch: app.fetch, port });

  logger.info({
    module: "engine",
    action: "ready",
    msg: `engine listening on http://0.0.0.0:${port}`,
    port,
    public_base_url: env.PUBLIC_BASE_URL ?? null,
  });

  // Tunnel WebSocket listener — separate Bun.serve listener (Bun runtime
  // required) so tunnel agents have a place to connect. Defaults to PORT+1
  // when TUNNEL_PORT is not set.
  let tunnelWs: TunnelWsServerHandle | null = null;
  try {
    tunnelWs = startTunnelWsServer({
      db,
      port: env.TUNNEL_PORT ?? port + 1,
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

  const isSmoke = process.argv.includes(SMOKE_FLAG);

  await withContext(
    {
      trace_id: newTraceId(),
      tenant_id: "system",
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
