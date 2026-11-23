import { useSyncExternalStore } from "react";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

export type ConnectionCause =
  | "starting"
  | "stream_hello"
  | "stream_ended"
  | "stream_refused"
  | "server_shutdown"
  | "session_expired"
  | "tenant_context_changed"
  | "request_ok";

export interface Connectivity {
  status: LiveStatus;
  stream: LiveStatus;
  cause: ConnectionCause;
  traceId: string | null;
}

export interface ConnectionLogEntry {
  code: string;
  at: string;
}

const LOG_MAX = 10;

const TRACE = /^[\w-]{8,64}$/;

function logCode(event: "offline" | "recovered", next: Connectivity): string {
  const trace = next.traceId ? ` trace=${next.traceId}` : "";
  return `connection.${event} status=${next.status} cause=${next.cause}${trace}`;
}

export function createConnectivity(now: () => Date = () => new Date()) {
  let state: Connectivity = {
    status: "connecting",
    stream: "connecting",
    cause: "starting",
    traceId: null,
  };
  let log: ConnectionLogEntry[] = [];
  const listeners = new Set<() => void>();

  function set(next: Connectivity): void {
    if (
      next.status === state.status &&
      next.stream === state.stream &&
      next.cause === state.cause &&
      next.traceId === state.traceId
    )
      return;
    const wasLive = state.status === "live";
    const isLive = next.status === "live";
    const event =
      wasLive && !isLive
        ? "offline"
        : !wasLive && isLive && state.status !== "connecting"
          ? "recovered"
          : null;
    if (event)
      log = [...log, { code: logCode(event, next), at: now().toISOString() }].slice(-LOG_MAX);
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    get: (): Connectivity => state,
    log: (): readonly ConnectionLogEntry[] => log,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stream(status: LiveStatus, cause: ConnectionCause, traceId: string | null = null): void {
      const trace = traceId && TRACE.test(traceId) ? traceId : null;
      set({
        status,
        stream: status,
        cause,
        traceId: status === "live" ? null : (trace ?? state.traceId),
      });
    },
    reachable(): void {
      if (state.status === "live") return;
      set({ ...state, status: "live", cause: "request_ok", traceId: null });
    },
    failed(traceId: string | null): void {
      if (!traceId || !TRACE.test(traceId)) return;
      set({ ...state, traceId });
    },
  };
}

export type ConnectivityStore = ReturnType<typeof createConnectivity>;

export const connectivity: ConnectivityStore = createConnectivity();

export function useConnectivity(store: ConnectivityStore = connectivity): Connectivity {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
