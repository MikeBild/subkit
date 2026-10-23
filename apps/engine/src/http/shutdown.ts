export interface ShutdownHttpServer {
  close(callback: () => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface HttpShutdown {
  closed: Promise<void>;
  forceClose: () => void;
  waitUntilClosed: (timeoutMs: number) => Promise<boolean>;
}

export function beginHttpShutdown(server: ShutdownHttpServer): HttpShutdown {
  const closed = new Promise<void>((resolve) => {
    server.close(resolve);
  });
  server.closeIdleConnections?.();

  return {
    closed,
    forceClose: () => server.closeAllConnections?.(),
    waitUntilClosed: (timeoutMs) =>
      Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]),
  };
}

export type HttpDrainOutcome = "closed" | "closed_after_force" | "abandoned";

export async function drainHttpBounded(
  shutdown: HttpShutdown,
  limits: { forceWaitMs: number; abandonWaitMs: number },
): Promise<HttpDrainOutcome> {
  shutdown.forceClose();
  if (await shutdown.waitUntilClosed(limits.forceWaitMs)) return "closed";
  if (await shutdown.waitUntilClosed(limits.abandonWaitMs)) return "closed_after_force";
  return "abandoned";
}
