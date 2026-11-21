import { createSseParser, type SseFrame as SharedSseFrame } from "@shared/sse.ts";

export type SseFrame = Pick<SharedSseFrame, "event" | "data">;

export async function readSse(
  response: Response,
  onFrame: (frame: SseFrame) => unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
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
      for (const frame of parse(decoder.decode(value, { stream: true }))) {
        if (frame.data === "") continue;
        if (onFrame({ event: frame.event, data: frame.data }) === false) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {}
  }
}
