import { testEnv } from "./env.ts";
export interface SeededRandom {
  float(): number;
  int(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
  bytes(n: number): Uint8Array;
  reset(): void;
}

export function createSeededRandom(seed: number): SeededRandom {
  const initial = seed >>> 0;
  let state = initial;

  const nextU32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  return {
    float: () => nextU32() / 0x1_0000_0000,
    int: (min: number, max: number) => {
      if (max < min) throw new Error(`int(${min}, ${max}): max < min`);
      const span = max - min + 1;
      return min + (nextU32() % span);
    },
    pick: <T>(xs: readonly T[]): T => {
      if (xs.length === 0) throw new Error("pick from empty array");
      const item = xs[nextU32() % xs.length];
      return item as T;
    },
    bytes: (n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = nextU32() & 0xff;
      return out;
    },
    reset: () => {
      state = initial;
    },
  };
}

export function seedFromEnv(fallback = 1): number {
  const raw = testEnv.SUBKIT_DETERMINISTIC_SEED;
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
