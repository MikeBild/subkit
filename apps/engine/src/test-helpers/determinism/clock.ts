import { getNowProvider, setTestNow } from "../../utils/clock.ts";

export { type NowProvider, setTestNow } from "../../utils/clock.ts";

export const FROZEN_NOW = 1_700_000_000_000;

export interface DeterministicClock {
  now(): number;
  advanceBy(ms: number): number;
  setTo(value: number): number;
}

export function createDeterministicClock(start: number = FROZEN_NOW): DeterministicClock {
  let current = start;
  return {
    now: () => current,
    advanceBy: (ms: number) => {
      current += ms;
      return current;
    },
    setTo: (value: number) => {
      current = value;
      return current;
    },
  };
}

export function installClock(
  clock: DeterministicClock,
): import("../../utils/clock.ts").NowProvider | null {
  const prev = getNowProvider();
  setTestNow(() => clock.now());
  return prev;
}

export function restoreClock(prev: import("../../utils/clock.ts").NowProvider | null): void {
  setTestNow(prev);
}

export { now as getTestNow } from "../../utils/clock.ts";
