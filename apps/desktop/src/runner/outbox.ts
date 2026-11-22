import { backoffDelay } from "@shared/backoff.ts";

export interface ResultOutboxOptions {
  deliver: (commandId: string) => Promise<void>;
  failed: (error: unknown) => void;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter: () => number;
}

export interface ResultOutbox {
  add(commandId: string): void;
  wake(): void;
  close(): void;
}

export function createResultOutbox(options: ResultOutboxOptions): ResultOutbox {
  const queue: string[] = [];
  let closed = false;
  let delivering = false;
  let pause = new AbortController();

  const drain = async () => {
    let attempt = 0;
    while (queue.length > 0 && !closed) {
      const commandId = queue[0] as string;
      try {
        await options.deliver(commandId);
        queue.shift();
        attempt = 0;
      } catch (error) {
        options.failed(error);
        pause = new AbortController();
        await options.wait(backoffDelay(attempt++, options.jitter()), pause.signal);
      }
    }
  };

  const start = () => {
    if (delivering || closed) return;
    delivering = true;
    drain().then(
      () => {
        delivering = false;
      },
      (error) => {
        delivering = false;
        options.failed(error);
      },
    );
  };

  return {
    add(commandId) {
      if (!queue.includes(commandId)) queue.push(commandId);
      start();
    },
    wake() {
      pause.abort();
    },
    close() {
      closed = true;
      pause.abort();
    },
  };
}
