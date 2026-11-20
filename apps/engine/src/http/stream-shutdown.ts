export const SERVER_SHUTDOWN_EVENT = "server.shutdown";

export interface StreamShutdown {
  readonly signal: AbortSignal;
  begin(): void;
}

export function createStreamShutdown(): StreamShutdown {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    begin: () => {
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

const engineStreams = createStreamShutdown();

export function beginStreamShutdown(): void {
  engineStreams.begin();
}

export function streamShutdownSignal(): AbortSignal {
  return engineStreams.signal;
}

export function shutdownFrame(): { event: string; data: string } {
  return { event: SERVER_SHUTDOWN_EVENT, data: JSON.stringify({ reason: "shutdown" }) };
}
