// Deterministic id factories for tests.
//
// Tests should not depend on crypto.randomBytes / randomUUID. A counter
// per factory keeps ids unique within a test and exactly replayable
// across runs.
//

export interface IdFactory {
  /** Next id in the sequence. */
  next(label?: string): string;
  /** Reset to zero. */
  reset(): void;
  /** Current counter (for assertions). */
  count(): number;
}

export function createDeterministicIdFactory(prefix: string): IdFactory {
  let counter = 0;
  return {
    next(label?: string) {
      const suffix = label ? `${label}-` : "";
      return `${prefix}-${suffix}${String(counter++).padStart(6, "0")}`;
    },
    reset() {
      counter = 0;
    },
    count() {
      return counter;
    },
  };
}

/** Shared global counter — mirrors tacktics' `createDeterministicSequenceId`. */
let sharedCounter = 0;

export function resetAllDeterministicIds(): void {
  sharedCounter = 0;
}

export function createDeterministicSequenceId(prefix: string, seed: string | number): string {
  return `${prefix}-${seed}-${String(sharedCounter++).padStart(4, "0")}`;
}

/** Deterministic replacement for `randomBytes(n).toString('hex')`. Same
 *  seed + call index → same bytes. Uses the same mulberry32 PRNG as
 *  random.ts so one shared seed threads the whole test. */
export function createDeterministicHexFactory(seed: number): (bytes: number) => string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return (bytes: number) => {
    const out: string[] = [];
    for (let i = 0; i < bytes; i++) {
      out.push((next() & 0xff).toString(16).padStart(2, "0"));
    }
    return out.join("");
  };
}

/** Deterministic UUID v4-shaped string (not RFC-compliant random, but
 *  well-formed). Useful when the code under test only validates shape. */
export function createDeterministicUuidFactory(seed: number): () => string {
  const hex = createDeterministicHexFactory(seed);
  return () => {
    const s = hex(16);
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
  };
}
