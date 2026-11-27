import { backoffDelay } from "@shared/backoff.ts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { noticeSessionExpiry } from "@/api/client";
import { readSseStream, SseHttpError } from "@/lib/sse-stream";
import { connectivity, type LiveStatus, useConnectivity } from "./connectivity";
import { invalidationBatcher } from "./invalidation-batcher";
import { keysForEvent } from "./live-invalidation";

const LIVE_STREAM_PATH = "/v1/cockpit/events/stream";

export type { LiveStatus } from "./connectivity";

interface LiveContextValue {
  status: LiveStatus;
  serverVersion: string | null;
}

const LiveContext = createContext<string | null>(null);

const RETRY_MAX_MS = 30_000;

interface HelloFrame {
  cursor?: unknown;
  version?: unknown;
  truncated?: unknown;
}

export type LiveFrameKind = "hello" | "ping" | "shutdown" | "change";

export const SERVER_SHUTDOWN_EVENT = "server.shutdown";

export function liveFrameKind(event: string): LiveFrameKind {
  if (event === "hello" || event === "ping") return event;
  return event === SERVER_SHUTDOWN_EVENT ? "shutdown" : "change";
}

export function statusAfterStreamEnd(shutdown: boolean): LiveStatus {
  return shutdown ? "offline" : "reconnecting";
}

export function streamRefusal(error: unknown): "session_expired" | "tenant_context_changed" | null {
  if (!(error instanceof SseHttpError)) return null;
  if (error.status === 401 || error.status === 403) return "session_expired";
  return error.status === 409 && error.code === "tenant_context_changed"
    ? "tenant_context_changed"
    : null;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

type FrameListener = (event: string, data: string) => void;
const frameListeners = new Set<FrameListener>();

export function subscribeLiveFrames(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const lastEventId = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const batcher = invalidationBatcher(queryClient);

    const stop = () => {
      controller?.abort();
      controller = null;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const connect = () => {
      if (disposed || controller) return;
      const current = new AbortController();
      controller = current;
      let shutdown = false;
      void readSseStream(LIVE_STREAM_PATH, {
        signal: current.signal,
        lastEventId: lastEventId.current,
        onFrame: (frame) => {
          const kind = liveFrameKind(frame.event);
          if (kind === "shutdown") {
            shutdown = true;
            return;
          }
          if (kind === "hello") {
            attempt = 0;
            connectivity.stream("live", "stream_hello");
            const hello = parseJson(frame.data) as HelloFrame | null;
            if (typeof hello?.version === "string") setServerVersion(hello.version);
            if (
              typeof hello?.cursor === "number" &&
              hello.cursor > Number(lastEventId.current ?? 0)
            )
              lastEventId.current = String(hello.cursor);
            if (hello?.truncated === true) batcher.everything();
            return;
          }
          if (kind === "ping") return;
          if (frame.id) lastEventId.current = frame.id;
          for (const listener of frameListeners) listener(frame.event, frame.data);
          batcher.schedule(keysForEvent(frame.event));
        },
      })
        .then(() => retry(current, shutdown))
        .catch((error: unknown) => {
          const refusal = streamRefusal(error);
          if (refusal && error instanceof SseHttpError) {
            if (refusal === "session_expired") noticeSessionExpiry(error.status, error.code);
            if (controller === current) controller = null;
            connectivity.stream("offline", refusal, error.traceId);
            return;
          }
          retry(current, shutdown, error instanceof SseHttpError ? error : null);
        });
    };

    const retry = (
      ended: AbortController,
      shutdown = false,
      refused: SseHttpError | null = null,
    ) => {
      if (controller !== ended) return;
      controller = null;
      if (disposed) return;
      connectivity.stream(
        statusAfterStreamEnd(shutdown),
        shutdown ? "server_shutdown" : refused ? "stream_refused" : "stream_ended",
        refused?.traceId ?? null,
      );
      retryTimer = setTimeout(connect, backoffDelay(attempt, 1, { maxMs: RETRY_MAX_MS }));
      attempt += 1;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      attempt = 0;
      connect();
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState !== "hidden") connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [queryClient]);

  return <LiveContext.Provider value={serverVersion}>{children}</LiveContext.Provider>;
}

export function useLiveStatus(): LiveContextValue {
  const { status } = useConnectivity();
  const serverVersion = useContext(LiveContext);
  return useMemo(() => ({ status, serverVersion }), [status, serverVersion]);
}

export const LIVE = true;

const OFFLINE_REFRESH_MS = 60_000;

export function useLiveQueryOptions(): { refetchInterval: number | false } {
  const { stream } = useConnectivity();
  return { refetchInterval: stream === "live" ? false : OFFLINE_REFRESH_MS };
}
