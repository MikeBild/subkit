export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

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
  readonly code: string | null;
  constructor(status: number, code: string | null = null) {
    super(`Event stream refused (${status})`);
    this.name = "SseHttpError";
    this.status = status;
    this.code = code;
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
  if (options.lastEventId) headers.set("last-event-id", options.lastEventId);
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers,
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    throw new SseHttpError(response.status, typeof body?.code === "string" ? body.code : null);
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
