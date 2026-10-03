// A small server-sent-events reader over `fetch`.
//
// Not `EventSource`: a fresh EventSource cannot be told where to resume — it
// sends `Last-Event-ID` only on its own automatic retry — and the live client
// closes the stream while the tab is hidden and reopens it on return. Reading
// the stream through `fetch` keeps that resume point in our hands and lets the
// request carry the Cockpit's own headers.

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Splits a text stream into SSE frames. Feed it chunks as they arrive; it
 * returns the frames that are complete and keeps the rest buffered. Comment
 * lines (`:`) are heartbeats and produce nothing.
 */
export function createSseParser(): (chunk: string) => SseFrame[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    const frames: SseFrame[] = [];
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      let id: string | null = null;
      let event = "message";
      const data: string[] = [];
      let fields = 0;
      for (const line of block.split("\n")) {
        if (line === "" || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        fields += 1;
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (fields > 0) frames.push({ id, event, data: data.join("\n") });
    }
    return frames;
  };
}

export class SseHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Event stream refused (${status})`);
    this.name = "SseHttpError";
    this.status = status;
  }
}

/**
 * Opens the stream and calls `onFrame` for each frame until the server ends it
 * or `signal` aborts. Resolves when the stream ends; rejects on a refused
 * request or a broken connection.
 */
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
  if (options.lastEventId) headers.set("last-event-id", options.lastEventId);
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers,
    signal: options.signal,
  });
  if (!response.ok || !response.body) throw new SseHttpError(response.status);
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
