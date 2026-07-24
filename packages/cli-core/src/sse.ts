// Minimal SSE reader shared by the `sk` CLI surfaces via
// `@cli-core/index.ts`. The engine emits
// `event: <name>\ndata: <json>\n\n` frames; we parse them into
// `{ event, data }` objects and surface each through a callback.

export interface SseFrame {
  event: string;
  data: string;
}

export async function readSse(
  response: Response,
  // biome-ignore lint/suspicious/noConfusingVoidType: existing consumers are notification callbacks; returning false is the opt-in early-stop signal.
  onFrame: (frame: SseFrame) => void | boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIdx = buffer.indexOf("\n\n");
      while (sepIdx >= 0) {
        const chunk = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const frame = parseFrame(chunk);
        if (frame && onFrame(frame) === false) {
          // A protocol-level terminal frame is stronger than transport EOF.
          // Actively cancel so a keep-alive SSE response cannot strand a
          // headless client after the operation has already completed.
          await reader.cancel().catch(() => {});
          return;
        }
        sepIdx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).replace(/^\s/, "");
    if (key === "event") event = value;
    else if (key === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
