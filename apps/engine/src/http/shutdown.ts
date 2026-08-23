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

/** Stop admission immediately while allowing active requests to finish with their queue work. */
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
