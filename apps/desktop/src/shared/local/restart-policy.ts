import { backoffDelay } from "@shared/backoff.ts";

export const RESTART_WINDOW_MS = 10 * 60_000;
export const RESTART_LIMIT = 5;

export interface RestartPlan {
  readonly delay_ms: number;
  readonly crashes: readonly number[];
}

export function restartPlan(crashes: readonly number[], now: number): RestartPlan | null {
  const recent = crashes.filter((at) => now - at < RESTART_WINDOW_MS && at <= now);
  if (recent.length >= RESTART_LIMIT) return null;
  return {
    delay_ms: backoffDelay(recent.length, 1),
    crashes: [...recent, now],
  };
}
