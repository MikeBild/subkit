interface FakeClock {
  now: () => number;
  date: () => Date;
  advance: (ms: number) => void;
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
