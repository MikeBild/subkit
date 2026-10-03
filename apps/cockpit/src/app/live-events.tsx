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
import { readSseStream, SseHttpError } from "@/lib/sse-stream";
import { keyId, keysForEvent } from "./live-invalidation";

// One live connection per Cockpit session.
//
// The engine streams what changed — an event type and the ids it concerns,
// never a payload — and this provider turns each frame into the query
// invalidations `live-invalidation.ts` names. Nothing in the Cockpit polls:
// a list is as fresh as the last event that touched it.
//
//   - Reconnects with backoff, resuming at the last event seen
//     (`Last-Event-ID`), so a dropped connection loses nothing.
//   - Closes while the tab is hidden and resumes on return; the replay of
//     what happened meanwhile is the catch-up.
//   - A resume the engine could not replay in full (`truncated`) refreshes
//     every read once instead of trusting a partial replay.
//   - The `hello` frame names the engine's version. A different version than
//     the one this bundle booted against means a new release is live.

export const LIVE_STREAM_PATH = "/v1/cockpit/events/stream";

/** Live connection state, for the one dot in the sidebar footer. */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

interface LiveContextValue {
  status: LiveStatus;
  /** The engine version the stream last announced, or null before the first hello. */
  serverVersion: string | null;
}

const LiveContext = createContext<LiveContextValue>({ status: "offline", serverVersion: null });

/** How long a burst of events is gathered into one refresh per key. */
export const COALESCE_MS = 300;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
}

interface HelloFrame {
  cursor?: unknown;
  version?: unknown;
  truncated?: unknown;
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
      void readSseStream(LIVE_STREAM_PATH, {
        signal: current.signal,
        lastEventId: lastEventId.current,
        onFrame: (frame) => {
          if (frame.event === "hello") {
            attempt = 0;
            setStatus("live");
            const hello = parseJson(frame.data) as HelloFrame | null;
            if (typeof hello?.version === "string") setServerVersion(hello.version);
            // The tail the stream starts at is the resume point even before
            // the first change arrives: a tab hidden right after connecting
            // still catches up on what happened meanwhile.
            if (
              typeof hello?.cursor === "number" &&
              hello.cursor > Number(lastEventId.current ?? 0)
            )
              lastEventId.current = String(hello.cursor);
            if (hello?.truncated === true) void queryClient.invalidateQueries();
            return;
          }
          if (frame.event === "ping") return;
          if (frame.id) lastEventId.current = frame.id;
          schedule(keysForEvent(frame.event));
        },
      })
        .then(() => retry(current))
        .catch((error: unknown) => {
          // A refused session will not be accepted on the next try either;
          // the session gate takes it from here.
          if (error instanceof SseHttpError && (error.status === 401 || error.status === 403)) {
            if (controller === current) controller = null;
            setStatus("offline");
            return;
          }
          retry(current);
        });
    };

    const retry = (ended: AbortController) => {
      if (controller !== ended) return; // closed on purpose (hidden tab, unmount)
      controller = null;
      if (disposed) return;
      setStatus("reconnecting");
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

/** The Cockpit refreshes from the event stream; nothing polls while it is live. */
export const LIVE = true;

/** The safety net while the stream is down: a slow refresh, and only then. */
const OFFLINE_REFRESH_MS = 60_000;

/**
 * Query options for a read the live stream keeps fresh. While the stream is
 * live there is no interval at all; while it is down the read falls back to a
 * slow refresh so a lost connection never leaves a page frozen.
 */
export function useLiveQueryOptions(): { refetchInterval: number | false } {
  const { status } = useLiveStatus();
  return { refetchInterval: status === "live" ? false : OFFLINE_REFRESH_MS };
}
