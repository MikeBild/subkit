// Injectable clock for tests.
//
// Most code under test takes a `now: () => number` or `() => Date` so
// callers can freeze + advance time deterministically. This helper
// gives every test the same primitives without re-implementing them.

export interface FakeClock {
  now: () => number;
  date: () => Date;
  /** Advance the clock by `ms`. */
  advance: (ms: number) => void;
  /** Set the clock to an absolute epoch milliseconds value. */
  setTime: (epochMs: number) => void;
}

export function createFakeClock(initialEpochMs = 1_700_000_000_000): FakeClock {
  let current = initialEpochMs;
  return {
    now: () => current,
    date: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    setTime: (epochMs: number) => {
      current = epochMs;
    },
  };
}
