import { spyOn } from "bun:test";
import * as rateLimits from "../db/rate-limits.ts";

type AdmitPersistentRateLimits = typeof rateLimits.admitPersistentRateLimits;

export interface PinnedAdmissionCall {
  limits: Parameters<AdmitPersistentRateLimits>[0];
  executor: Parameters<AdmitPersistentRateLimits>[1];
  timestamp: Date;
}

export interface PinnedAdmissionClock {
  readonly calls: readonly PinnedAdmissionCall[];
  setInstant(timestamp: Date): void;
  restore(): void;
}

let active = false;

export function pinAdmissionClock(initial: Date): PinnedAdmissionClock {
  if (active) throw new Error("pinned admission clock is already installed");
  active = true;
  let current = new Date(initial);
  const original = rateLimits.admitPersistentRateLimits;
  const calls: PinnedAdmissionCall[] = [];
  let spy: ReturnType<typeof spyOn>;
  try {
    spy = spyOn(rateLimits, "admitPersistentRateLimits").mockImplementation(
      async (limits, executor, timestamp) => {
        const actualTimestamp = timestamp ? new Date(timestamp) : new Date(current);
        calls.push({ limits, executor, timestamp: actualTimestamp });
        return original(limits, executor, actualTimestamp);
      },
    );
  } catch (error) {
    active = false;
    throw error;
  }
  let restored = false;

  return {
    calls,
    setInstant: (timestamp) => {
      current = new Date(timestamp);
    },
    restore: () => {
      if (restored) return;
      restored = true;
      try {
        spy.mockRestore();
      } finally {
        active = false;
      }
    },
  };
}

export function minuteBucketStart(timestamp: Date): Date {
  const bucket = new Date(timestamp);
  bucket.setUTCSeconds(0, 0);
  return bucket;
}
