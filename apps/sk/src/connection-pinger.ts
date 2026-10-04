import type { EngineClient } from "./engine-client.ts";
import type { ConnectionState } from "./repl/status-line/render.ts";

export interface ConnectionPingerOptions {
  client: EngineClient;
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
}

export interface ConnectionSnapshot {
  state: ConnectionState;
  reason: string | null;
  last_ok_at: number | null;
  last_error_at: number | null;
}

type Listener = (snapshot: ConnectionSnapshot) => void;

export class ConnectionPinger {
  private readonly client: EngineClient;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private state: ConnectionState = "unknown";
  private reason: string | null = null;
  private lastOk: number | null = null;
  private lastErr: number | null = null;
  private listeners = new Set<Listener>();
  private running = false;

  constructor(opts: ConnectionPingerOptions) {
    this.client = opts.client;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.failureThreshold = opts.failureThreshold ?? 2;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    const schedule = (): void => {
      if (!this.running) return;
      this.timer = setTimeout(async () => {
        await this.tick();
        schedule();
      }, this.intervalMs);
      this.timer.unref?.();
    };
    schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  snapshot(): ConnectionSnapshot {
    return {
      state: this.state,
      reason: this.reason,
      last_ok_at: this.lastOk,
      last_error_at: this.lastErr,
    };
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async tick(): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), this.timeoutMs);
    try {
      await this.client.health();
      clearTimeout(timer);
      this.consecutiveFailures = 0;
      this.lastOk = Date.now();
      this.reason = null;
      this.transition("online");
    } catch (err) {
      clearTimeout(timer);
      this.consecutiveFailures += 1;
      this.lastErr = Date.now();
      this.reason = err instanceof Error ? err.message : String(err);
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.transition("offline");
      } else {
        this.transition("reconnecting");
      }
    }
  }

  private transition(next: ConnectionState): void {
    if (next === this.state) return;
    this.state = next;
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {}
    }
  }
}
