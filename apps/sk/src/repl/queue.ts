export interface CommandQueue {
  enqueue(text: string): boolean;
  dequeue(): string | undefined;
  peek(): string | undefined;
  clear(): void;
  readonly length: number;
  readonly items: readonly string[];
}

export interface QueueOptions {
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
