import { closeAllPools } from "../connectors/drivers/postgres.ts";
import { closeDb, type Db } from "../db/client.ts";
import type { EngineBootLifetime } from "../engine-boot-lifetime.ts";
import { tenantWorkInFlight, waitForTenantWorkDrain } from "../execution/index.ts";
import { setHealthState } from "../http/health-state.ts";
import { beginHttpShutdown, drainHttpBounded, type HttpShutdown } from "../http/shutdown.ts";
import { beginStreamShutdown } from "../http/stream-shutdown.ts";
import { errorFields, logger } from "../logging/index.ts";
import { stopAllStdioServers } from "../mcp/client/stdio-supervisor.ts";
import type { RuntimeConfigCoordinator } from "../runtime-config/index.ts";
import { registerRestartTrigger, shutdownExitCode } from "../runtime-config/restart.ts";
import { closeSandboxWorkers } from "../sandboxes/quickjs/runtime.ts";

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 120_000;
const HTTP_CLOSE_ABANDON_MS = 10_000;

export type ShutdownSignal = NodeJS.Signals | "restart" | "boot_failure";

export interface EngineShutdown {
  readonly shutdown: (signal: ShutdownSignal, exitCode?: number) => Promise<void>;
  readonly attachDatabase: (db: Db) => void;
  readonly attachRuntimeConfig: (coordinator: RuntimeConfigCoordinator) => void;
  readonly attachHttpServer: (server: Parameters<typeof beginHttpShutdown>[0]) => void;
}

export function createEngineShutdown(lifetime: EngineBootLifetime): EngineShutdown {
  let database: Db | null = null;
  let runtimeConfig: RuntimeConfigCoordinator | null = null;
  let httpShutdown: HttpShutdown | null = null;
  let shutting: Promise<void> | undefined;
  let requestedExitCode = shutdownExitCode("signal");

  const shutdown = (signal: ShutdownSignal, exitCode = shutdownExitCode("signal")) => {
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
    beginStreamShutdown();
    const drained = lifetime.stop();
    const forceHttpClose = setTimeout(() => httpShutdown?.forceClose(), SHUTDOWN_DRAIN_TIMEOUT_MS);
    forceHttpClose.unref?.();
    shutting = (async () => {
      try {
        await drained;
        const httpDrain = httpShutdown
          ? await drainHttpBounded(httpShutdown, {
              forceWaitMs: 1_000,
              abandonWaitMs: HTTP_CLOSE_ABANDON_MS,
            })
          : "closed";
        if (httpDrain !== "closed")
          logger.warn({
            module: "http",
            action: "shutdown.http_force_close_timeout",
            msg: "HTTP close callback remained pending after force-closing connections",
            timeout_ms: 1_000,
          });
        const httpClosed = httpDrain !== "abandoned";
        if (!httpClosed) {
          requestedExitCode = shutdownExitCode("timeout");
          logger.warn({
            module: "http",
            action: "shutdown.http_close_abandoned",
            msg: "HTTP server never confirmed close; continuing shutdown without it",
            timeout_ms: HTTP_CLOSE_ABANDON_MS,
          });
        }
        await waitForTenantWorkDrain();
        await lifetime.finalize();
        closeSandboxWorkers();
        await stopAllStdioServers();
        await closeAllPools();
        const inFlight = tenantWorkInFlight();
        if (httpClosed && inFlight === 0) await runtimeConfig?.stop();
        else
          logger.warn({
            module: "runtime_config",
            action: "shutdown.replica_registration_retained",
            msg: "Shutdown has unsettled work; replica registration retained for operator review",
            http_closed: httpClosed,
            in_flight: inFlight,
          });
        if (database) await closeDb();
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
  lifetime.registerStop(
    registerRestartTrigger(() => void shutdown("restart", shutdownExitCode("restart"))),
  );

  return {
    shutdown,
    attachDatabase: (db) => {
      database = db;
    },
    attachRuntimeConfig: (coordinator) => {
      runtimeConfig = coordinator;
    },
    attachHttpServer: (server) => {
      httpShutdown = beginHttpShutdown(server);
    },
  };
}
