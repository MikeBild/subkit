import { type QueryKey, useQueryClient } from "@tanstack/react-query";
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
import { keyId, keysForEvent } from "./live-invalidation";

const LIVE_STREAM_PATH = "/v1/cockpit/events/stream";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

interface LiveContextValue {
  status: LiveStatus;
  serverVersion: string | null;
}

const LiveContext = createContext<LiveContextValue>({ status: "offline", serverVersion: null });

const COALESCE_MS = 300;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
}

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

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const lastEventId = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const pending = new Map<string, QueryKey>();

    const flush = () => {
      flushTimer = null;
      const keys = [...pending.values()];
      pending.clear();
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    };

    const schedule = (keys: readonly QueryKey[]) => {
      for (const key of keys) pending.set(keyId(key), key);
      if (pending.size > 0 && flushTimer === null) flushTimer = setTimeout(flush, COALESCE_MS);
    };

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
            setStatus("live");
            const hello = parseJson(frame.data) as HelloFrame | null;
            if (typeof hello?.version === "string") setServerVersion(hello.version);
            if (
              typeof hello?.cursor === "number" &&
              hello.cursor > Number(lastEventId.current ?? 0)
            )
              lastEventId.current = String(hello.cursor);
            if (hello?.truncated === true) void queryClient.invalidateQueries();
            return;
          }
          if (kind === "ping") return;
          if (frame.id) lastEventId.current = frame.id;
          schedule(keysForEvent(frame.event));
        },
      })
        .then(() => retry(current, shutdown))
        .catch((error: unknown) => {
          if (error instanceof SseHttpError && (error.status === 401 || error.status === 403)) {
            noticeSessionExpiry(error.status, error.code);
            if (controller === current) controller = null;
            setStatus("offline");
            return;
          }
          retry(current, shutdown);
        });
    };

    const retry = (ended: AbortController, shutdown = false) => {
      if (controller !== ended) return;
      controller = null;
      if (disposed) return;
      setStatus(statusAfterStreamEnd(shutdown));
      retryTimer = setTimeout(connect, backoffDelay(attempt));
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
      if (flushTimer !== null) clearTimeout(flushTimer);
    };
  }, [queryClient]);

  const value = useMemo(() => ({ status, serverVersion }), [status, serverVersion]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLiveStatus(): LiveContextValue {
  return useContext(LiveContext);
}

export const LIVE = true;

const OFFLINE_REFRESH_MS = 60_000;

export function useLiveQueryOptions(): { refetchInterval: number | false } {
  const { status } = useLiveStatus();
  return { refetchInterval: status === "live" ? false : OFFLINE_REFRESH_MS };
}
