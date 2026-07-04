// Busy-turn command queue.
//
// While the REPL is streaming a turn we normally gate the composer
// so a held-down Enter key can't spawn duplicate turns. That has one
// annoying side effect: a user who is thinking three moves ahead
// has no way to stage the next instruction until the current turn
// finishes.
//
// `createQueue` tracks a FIFO of staged prompts. The composer feeds
// it via `enqueue(text)` while `busy` is true, and the InkApp drains
// the queue once the streaming loop finishes — one prompt at a time,
// preserving order.
//
// The queue is bounded (default 16 entries). Overflow drops the
// newest push so a runaway script can't balloon memory.

export interface CommandQueue {
  enqueue(text: string): boolean;
  dequeue(): string | undefined;
  peek(): string | undefined;
  clear(): void;
  readonly length: number;
  readonly items: readonly string[];
}

export interface QueueOptions {
  /** Max entries kept in the queue. Overflow is dropped. */
  maxSize?: number;
}

export function createQueue(opts: QueueOptions = {}): CommandQueue {
  const max = opts.maxSize ?? 16;
  const buf: string[] = [];
  return {
    enqueue(text: string): boolean {
      const trimmed = text.trim();
      if (trimmed.length === 0) return false;
      if (buf.length >= max) return false;
      buf.push(trimmed);
      return true;
    },
    dequeue(): string | undefined {
      return buf.shift();
    },
    peek(): string | undefined {
      return buf[0];
    },
    clear(): void {
      buf.length = 0;
    },
    get length(): number {
      return buf.length;
    },
    get items(): readonly string[] {
      return buf;
    },
  };
}
