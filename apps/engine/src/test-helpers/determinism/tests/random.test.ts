import { afterEach, describe, expect, it } from "bun:test";
import { testEnv } from "../env.ts";
import { createSeededRandom, seedFromEnv } from "../random.ts";

describe("random", () => {
  it("same seed reproduces the same float sequence", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(1);
    for (let i = 0; i < 50; i++) expect(a.float()).toBe(b.float());
  });

  it("different seeds produce different sequences", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const da: number[] = [];
    const db: number[] = [];
    for (let i = 0; i < 50; i++) {
      da.push(a.float());
      db.push(b.float());
    }
    expect(da).not.toEqual(db);
  });

  it("float() is in [0, 1)", () => {
    const r = createSeededRandom(42);
    for (let i = 0; i < 1000; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it("int(min, max) is in the requested range", () => {
    const r = createSeededRandom(42);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(10, 20);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(20);
    }
  });

  it("int rejects max < min", () => {
    const r = createSeededRandom(0);
    expect(() => r.int(10, 5)).toThrow(/max < min/);
  });

  it("pick returns an element from the array", () => {
    const r = createSeededRandom(7);
    const xs = ["a", "b", "c"] as const;
    for (let i = 0; i < 100; i++) {
      expect(xs).toContain(r.pick(xs));
    }
  });

  it("pick rejects empty arrays", () => {
    const r = createSeededRandom(0);
    expect(() => r.pick([])).toThrow(/empty/);
  });

  it("bytes returns the requested length", () => {
    const r = createSeededRandom(3);
    expect(r.bytes(16)).toHaveLength(16);
    expect(r.bytes(0)).toHaveLength(0);
  });

  it("reset() restores the initial state", () => {
    const r = createSeededRandom(99);
    const first = [r.float(), r.float(), r.float()];
    r.reset();
    expect([r.float(), r.float(), r.float()]).toEqual(first);
  });

  describe("seedFromEnv", () => {
    const KEY = "SUBKIT_DETERMINISTIC_SEED";
    const original = testEnv[KEY];
    afterEach(() => {
      if (original === undefined) delete testEnv[KEY];
      else testEnv[KEY] = original;
    });

    it("falls back when the env var is unset", () => {
      delete testEnv[KEY];
      expect(seedFromEnv(123)).toBe(123);
    });

    it("reads a numeric env var", () => {
      testEnv[KEY] = "77";
      expect(seedFromEnv(1)).toBe(77);
    });

    it("falls back on non-numeric values", () => {
      testEnv[KEY] = "not-a-number";
      expect(seedFromEnv(5)).toBe(5);
    });
  });
});
