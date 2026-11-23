import { backoffDelay } from "@shared/backoff.ts";
import { createSseParser, type SseFrame } from "@shared/sse.ts";
import { type AuthFailure, classifyAuthFailure } from "./server-contract.ts";

export type StreamStatus = "connecting" | "online" | "offline" | AuthFailure;

export interface StreamResponse {
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export function refusalMessage(status: number, body: unknown, traceId: string | null): string {
  const code =
    body && typeof body === "object" ? (body as Record<string, unknown>).code : undefined;
  const parts = [`event stream answered ${status}`];
  if (typeof code === "string" && /^[\w.-]{1,80}$/.test(code)) parts.push(`code=${code}`);
  if (traceId && /^[\w-]{8,64}$/.test(traceId)) parts.push(`trace=${traceId}`);
  return parts.join(" ");
}

export interface StreamDeps {
  fetch(
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ): Promise<StreamResponse>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  jitter(): number;
}

export interface StreamOptions {
  url: string;
  lastEventId: string | null;
  signal: AbortSignal;
  deps: StreamDeps;
  idleTimeoutMs?: number | (() => number);
  onEvent(event: SseFrame): void;
  onStatus(status: StreamStatus): void;
  onError?(error: unknown): void;
}

export const STREAM_IDLE_TIMEOUT_MS = 75_000;

async function readBody(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  touch: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      touch();
      onChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runEventStream(options: StreamOptions): Promise<AuthFailure | "stopped"> {
  const { deps, signal } = options;
  let lastEventId = options.lastEventId;
  let attempt = 0;
  let reported: StreamStatus | null = null;
  const report = (status: StreamStatus) => {
    if (status !== reported) options.onStatus(status);
    reported = status;
  };
  report("connecting");
  while (!signal.aborted) {
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idle);
      const limit = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
      idle = setTimeout(abort, typeof limit === "function" ? limit() : limit);
    };
    try {
      touch();
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const response = await deps.fetch(options.url, { headers, signal: connection.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const failure = classifyAuthFailure(response.status, body);
        if (failure) {
          report(failure);
          return failure;
        }
        throw new Error(
          refusalMessage(response.status, body, response.headers?.get("x-trace-id") ?? null),
        );
      }
      if (!response.body) throw new Error("event stream has no body");
      report("online");
      attempt = 0;
      const parse = createSseParser();
      const deliver = (text: string) => {
        for (const event of parse(text)) {
          if (event.id) lastEventId = event.id;
          options.onEvent(event);
        }
      };
      await readBody(response.body, deliver, touch);
    } catch (error) {
      if (!signal.aborted) options.onError?.(error);
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", abort);
      connection.abort();
    }
    if (signal.aborted) break;
    report("offline");
    await deps.sleep(backoffDelay(attempt, deps.jitter()), signal);
    attempt += 1;
  }
  return "stopped";
}
