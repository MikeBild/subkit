import { logger } from "../logging/logger.ts";

const WINDOW_MS = 5 * 60 * 1000;
const THRESHOLD = 10;
const PRUNE_INTERVAL_MS = 60_000;

interface Entry {
  count: number;
  first: number;
  alerted: boolean;
}

const failures = new Map<string, Entry>();

let lastPrune = Date.now();

function pruneStale(now: number): void {
  for (const [ip, entry] of failures) {
    if (now - entry.first > WINDOW_MS) {
      failures.delete(ip);
    }
  }
  lastPrune = now;
}

export function recordAuthFailure(ip: string): void {
  const now = Date.now();

  if (now - lastPrune > PRUNE_INTERVAL_MS) {
    pruneStale(now);
  }

  const existing = failures.get(ip);
  if (existing && now - existing.first < WINDOW_MS) {
    existing.count++;
    if (existing.count >= THRESHOLD && !existing.alerted) {
      existing.alerted = true;
      logger.warn({
        module: "auth",
        action: "brute_force_detected",
        msg: `${existing.count} failed auth attempts from ${ip} in ${Math.round(WINDOW_MS / 1000)}s window`,
        ip,
        count: existing.count,
        window_ms: WINDOW_MS,
      });
    }
  } else {
    failures.set(ip, { count: 1, first: now, alerted: false });
  }
}
