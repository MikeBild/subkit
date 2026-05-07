// Async-iterable SSE source for unit/integration tests.
//
// Replaces ad-hoc fakes scattered through engine-client-recovery.test.ts
// and similar suites with one shared interface. The source exposes
// `pushDelta(text)`, `pushTool(call)`, `pushDone()`, `pushError(env)`
// and surfaces them through a real `ReadableStream` so callers can
// pipe into `EngineClient.streamConversation` (or any consumer that
// expects an SSE byte stream).
//
// Each push enqueues the canonical `data: ...\n\n` frame matching the
// engine's `text/event-stream` response. The stream stays open until
// `close()` is called, mirroring the engine's behavior.

import { TextEncoder } from "node:util";

export interface MockSseHandle {
  pushDelta: (text: string) => void;
  pushTool: (call: { name: string; arguments: unknown }) => void;
  pushDone: (usage?: { input_tokens?: number; output_tokens?: number }) => void;
  pushError: (envelope: {
    code: string;
    message: string;
    hint?: string;
    retry_after?: number;
    details?: unknown;
  }) => void;
  pushRaw: (event: string, data: unknown) => void;
  close: () => void;
  /** ReadableStream the consumer pipes into. */
  stream: ReadableStream<Uint8Array>;
  /** True until close() is called. */
  isOpen: () => boolean;
}

interface PendingPush {
  event: string;
  data: unknown;
}

const TEXT = new TextEncoder();

export function createMockEngineSse(): MockSseHandle {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let open = true;
  const queue: PendingPush[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // Drain anything pushed before the consumer subscribed.
      for (const p of queue) flush(p);
      queue.length = 0;
    },
    cancel() {
      open = false;
      controller = null;
    },
  });

  const flush = (p: PendingPush): void => {
    if (!controller) {
      queue.push(p);
      return;
    }
    const body = typeof p.data === "string" ? p.data : JSON.stringify(p.data);
    const frame = `event: ${p.event}\ndata: ${body}\n\n`;
    controller.enqueue(TEXT.encode(frame));
  };

  return {
    stream,
    isOpen: () => open,
    pushDelta(text) {
      flush({ event: "text_delta", data: { text } });
    },
    pushTool(call) {
      flush({ event: "tool_call", data: call });
    },
    pushDone(usage) {
      flush({ event: "done", data: { usage: usage ?? null } });
    },
    pushError(envelope) {
      flush({ event: "error", data: envelope });
    },
    pushRaw(event, data) {
      flush({ event, data });
    },
    close() {
      open = false;
      controller?.close();
      controller = null;
    },
  };
}
