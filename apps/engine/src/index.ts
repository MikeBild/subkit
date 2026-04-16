import { serve } from "@hono/node-server";
import { ChatAdapterRegistry } from "./chat/registry.ts";
import { closeDb, getDb } from "./db/client.ts";
import { env } from "./env.ts";
import { createApp } from "./http/server.ts";
import { newTraceId, withContext } from "./logging/context.ts";
import { logger } from "./logging/logger.ts";
import { startListener, stopListener } from "./pubsub/listener.ts";
import { startBoss, stopBoss } from "./queue/boss.ts";
import { registerAllHandlers } from "./queue/handlers/index.ts";
import { SchedulerReconciler } from "./scheduler/reconciler.ts";
import { startTunnelWsServer, type TunnelWsServerHandle } from "./tunnels/ws-server.ts";

const SMOKE_FLAG = "--smoke";

async function runSmoke(): Promise<void> {
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
  const db = getDb();

  // Shared chat adapter registry — both the HTTP routes and the
  // outbound fanout worker resolve chat adapters out of this single
  // instance so notification dispatch can find adapters that were
  // registered via the /chat/install flow.
  const chatRegistry = new ChatAdapterRegistry();

  // Start pg-boss + register handlers before the HTTP server so enqueue
  // requests hitting the first byte always find a live boss.
  const boss = await startBoss({ connectionString: env.DATABASE_URL });
  await registerAllHandlers({ boss, db, chatRegistry });

  // Pub/sub listener — catch-up first, then LISTEN.
  const listener = await startListener({ connectionString: env.DATABASE_URL, db });

  // Cron reconciler — sync workflows_schedules -> pg-boss schedules.
  const reconciler = new SchedulerReconciler({ boss, db });
  await reconciler.start();

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
      await closeDb();
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
