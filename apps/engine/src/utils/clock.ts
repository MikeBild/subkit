export type NowProvider = () => number;

let nowOverride: NowProvider | null = null;

export function now(): number {
  // allow-wall-clock: this IS the seam — every other production
  // module reads time through `now()` from this file. A future
  // "scrub all Date.now()" sweep must leave this single call in
  // place; the override slot above is what makes determinism tests
  // deterministic in the first place.
  return nowOverride ? nowOverride() : Date.now();
}

export function setTestNow(provider: NowProvider | null): void {
  nowOverride = provider;
}

export function getNowProvider(): NowProvider | null {
  return nowOverride;
}
