import { createSseParser, type SseFrame } from "@shared/sse.ts";
import { noticeTenantContext, tenantContextHeaders } from "@/api/tenant-context";
import { cockpitApiHref } from "@/app/installation-context";

export class SseHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly traceId: string | null;
  constructor(status: number, code: string | null = null, traceId: string | null = null) {
    super(`Event stream refused (${status})`);
    this.name = "SseHttpError";
    this.status = status;
    this.code = code;
    this.traceId = traceId;
  }
}

export async function readSseStream(
  url: string,
  options: {
    signal: AbortSignal;
    lastEventId: string | null;
    onOpen?: () => void;
    onFrame: (frame: SseFrame) => void;
  },
): Promise<void> {
  const headers = new Headers({ accept: "text/event-stream", "x-subkit-client": "cockpit" });
  for (const [key, value] of Object.entries(tenantContextHeaders())) headers.set(key, value);
  if (options.lastEventId) headers.set("last-event-id", options.lastEventId);
  const response = await fetch(cockpitApiHref(url), {
    credentials: "same-origin",
    cache: "no-store",
    headers,
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : null;
    noticeTenantContext(response.status, code);
    throw new SseHttpError(response.status, code, response.headers.get("x-trace-id"));
  }
  options.onOpen?.();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const parse = createSseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const frame of parse(value)) options.onFrame(frame);
    }
  } finally {
    reader.releaseLock();
  }
}
