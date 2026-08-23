export interface ShutdownHttpServer {
  close(callback: () => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface HttpShutdown {
  closed: Promise<void>;
  forceClose: () => void;
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
  };
}
