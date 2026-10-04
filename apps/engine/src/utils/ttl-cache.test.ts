import { describe, expect, test } from "bun:test";
import { TtlCache } from "./ttl-cache.ts";

describe("TtlCache", () => {
  test("get returns undefined on miss and increments misses", () => {
    const cache = new TtlCache<number>({ maxEntries: 4, ttlMs: 1000 });
    expect(cache.get("x")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  test("set then get returns the value and counts as a hit", () => {
    const cache = new TtlCache<number>({ maxEntries: 4, ttlMs: 1000 });
    cache.set("x", 42);
    expect(cache.get("x")).toBe(42);
    expect(cache.stats().hits).toBe(1);
  });

  test("expired entries are dropped lazily on get", () => {
    let now = 0;
    const cache = new TtlCache<number>({ maxEntries: 4, ttlMs: 100, now: () => now });
    cache.set("x", 42);
    now = 50;
    expect(cache.get("x")).toBe(42);
    now = 200;
    expect(cache.get("x")).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  test("LRU evicts the oldest entry when at capacity", () => {
    const cache = new TtlCache<number>({ maxEntries: 2, ttlMs: 10_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("get touches recency so the touched key isn't evicted next", () => {
    const cache = new TtlCache<number>({ maxEntries: 2, ttlMs: 10_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  test("invalidatePrefix removes only matching entries", () => {
    const cache = new TtlCache<number>({ maxEntries: 10, ttlMs: 10_000 });
    cache.set("ten:foo", 1);
    cache.set("ten:bar", 2);
    cache.set("other:baz", 3);
    const removed = cache.invalidatePrefix("ten:");
    expect(removed).toBe(2);
    expect(cache.get("ten:foo")).toBeUndefined();
    expect(cache.get("other:baz")).toBe(3);
  });
});
