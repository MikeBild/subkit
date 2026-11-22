import { backoffDelay } from "@shared/backoff.ts";
import type { DeviceStopReport } from "@shared/device/protocol.ts";

export interface StopReporterOptions {
  send: (report: DeviceStopReport) => Promise<void>;
  acknowledged: (generation: number) => void;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter: () => number;
}

export interface StopReporter {
  report(report: DeviceStopReport): void;
  close(): void;
}

export function createStopReporter(options: StopReporterOptions): StopReporter {
  let latest: DeviceStopReport | null = null;
  let delivering = false;
  const closed = new AbortController();

  const deliver = async () => {
    let attempt = 0;
    while (latest && !closed.signal.aborted) {
      const current = latest;
      try {
        await options.send(current);
        options.acknowledged(current.generation);
        if (latest === current) latest = null;
        attempt = 0;
      } catch {
        await options.wait(backoffDelay(attempt++, options.jitter()), closed.signal);
      }
    }
    delivering = false;
  };

  return {
    report(next) {
      if (latest && latest.generation >= next.generation) return;
      latest = next;
      if (delivering) return;
      delivering = true;
      deliver().catch(() => {
        delivering = false;
      });
    },
    close() {
      closed.abort();
    },
  };
}

export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
