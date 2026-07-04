import { describe, expect, test } from "bun:test";
import { HeightCache } from "../repl/transcript/height-cache.ts";

describe("HeightCache", () => {
  test("get returns undefined for missing keys", () => {
    const c = new HeightCache();
    expect(c.get("k", 80)).toBeUndefined();
  });

  test("set+get round-trip", () => {
    const c = new HeightCache();
    c.set("k", 80, 4);
    expect(c.get("k", 80)).toBe(4);
  });

  test("get with mismatched width returns undefined (width-keyed)", () => {
    const c = new HeightCache();
    c.set("k", 80, 4);
    expect(c.get("k", 120)).toBeUndefined();
  });

  test("invalidate drops one key", () => {
    const c = new HeightCache();
    c.set("a", 80, 1);
    c.set("b", 80, 2);
    c.invalidate("a");
    expect(c.get("a", 80)).toBeUndefined();
    expect(c.get("b", 80)).toBe(2);
  });

  test("clear drops every entry", () => {
    const c = new HeightCache();
    c.set("a", 80, 1);
    c.set("b", 80, 2);
    c.clear();
    expect(c.size()).toBe(0);
  });

  test("LRU evicts oldest when over capacity", () => {
    const c = new HeightCache({ maxEntries: 16 });
    for (let i = 0; i < 20; i++) c.set(`k${i}`, 80, i);
    expect(c.size()).toBe(16);
    // The first ~4 entries should have been evicted.
    expect(c.get("k0", 80)).toBeUndefined();
    expect(c.get("k19", 80)).toBe(19);
  });

  test("touch on get prevents eviction", () => {
    const c = new HeightCache({ maxEntries: 16 });
    for (let i = 0; i < 15; i++) c.set(`k${i}`, 80, i);
    // Touch the oldest two.
    c.get("k0", 80);
    c.get("k1", 80);
    // Adding 4 more should evict NEW-ish entries before k0/k1.
    for (let i = 15; i < 19; i++) c.set(`k${i}`, 80, i);
    expect(c.get("k0", 80)).toBe(0);
    expect(c.get("k1", 80)).toBe(1);
  });

  test("setting an existing key updates value + width", () => {
    const c = new HeightCache();
    c.set("k", 80, 1);
    c.set("k", 80, 5);
    expect(c.get("k", 80)).toBe(5);
    c.set("k", 100, 7);
    expect(c.get("k", 80)).toBeUndefined();
    expect(c.get("k", 100)).toBe(7);
  });
});
