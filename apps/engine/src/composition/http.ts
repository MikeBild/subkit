import { serve } from "@hono/node-server";
import type { ChatAdapterRegistry } from "../chat/registry.ts";
import { getConfig } from "../config/loader.ts";
import { setLocalEngineOrigin } from "../credentials/index.ts";
import type { Db } from "../db/client.ts";
import type { EngineBootLifetime } from "../engine-boot-lifetime.ts";
import { envSnapshot } from "../env.ts";
import { engineServeOptions } from "../http/listen-hostname.ts";
import { OPENAPI_INFO } from "../http/openapi.ts";
import { createApp } from "../http/server.ts";
import {
  attachLocalLauncher,
  chooseLocalPort,
  LOCAL_LOOPBACK,
  type LocalWorkspace,
} from "../identity/local-workspace.ts";
import { logger } from "../logging/index.ts";
import { bootPhase, readMemoryUsage } from "../observability/runtime-telemetry.ts";
import type { EngineShutdown } from "./shutdown.ts";

export interface HttpDeps {
  readonly lifetime: EngineBootLifetime;
  readonly chatRegistry: ChatAdapterRegistry;
  readonly localWorkspace: LocalWorkspace | null;
  readonly shutdown: EngineShutdown;
  readonly recordBootConsumer: (name: string) => void;
}

export async function startHttp(db: Db, deps: HttpDeps): Promise<void> {
  const { lifetime, chatRegistry, localWorkspace, shutdown } = deps;
  lifetime.assertRunning();
  const app = createApp({ db, chatRegistry, ...(localWorkspace ? { localWorkspace } : {}) });
  const localPort = localWorkspace ? await chooseLocalPort(localWorkspace.preferredPort) : null;
  const port = localPort?.port ?? getConfig().server.port;
  if (localPort) setLocalEngineOrigin(`http://${LOCAL_LOOPBACK}:${localPort.port}`);
  deps.recordBootConsumer("http_server");

  const opts = engineServeOptions(port, envSnapshot(), localWorkspace !== null);
  await lifetime.acquire(
    () =>
      bootPhase("listen", () => {
        const server = serve({
          fetch: (request, env) => {
            if (lifetime.stopping) return new Response("Service unavailable", { status: 503 });
            return lifetime.handleRequest(() => app.fetch(request, env));
          },
          port: opts.port,
          hostname: opts.hostname,
        });
        return new Promise<typeof server>((resolve, reject) => {
          if (server.listening) return resolve(server);
          const failed = (error: Error) => reject(error);
          server.once("error", failed);
          server.once("listening", () => {
            server.off("error", failed);
            resolve(server);
          });
        });
      }),
    (server) => shutdown.attachHttpServer(server),
  );
  if (localWorkspace && localPort)
    await attachLocalLauncher(localWorkspace, localPort, () => void shutdown.shutdown("SIGHUP"));

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
}
