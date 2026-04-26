// Unit tests for the depth-limited sampler. The sampler must be a pure
// function: same input → same output, no side-effects on the input.

import { describe, expect, test } from "bun:test";
import {
  SAMPLE_MARKER_TRUNCATED_COUNT,
  SAMPLE_MARKER_TRUNCATED_KEYS,
  SAMPLE_MARKER_TRUNCATED_KIND,
  sampleObject,
} from "../sample-object.ts";

describe("sampleObject", () => {
  test("primitives pass through", () => {
    expect(sampleObject("hello")).toBe("hello");
    expect(sampleObject(42)).toBe(42);
    expect(sampleObject(true)).toBe(true);
    expect(sampleObject(null)).toBe(null);
    expect(sampleObject(undefined)).toBe(undefined);
  });

  test("shallow object copies through unchanged", () => {
    const input = { a: 1, b: "two", c: true };
    expect(sampleObject(input)).toEqual(input);
  });

  test("deep object collapses at the configured depth", () => {
    const deep = { l1: { l2: { l3: { l4: "buried" } } } };
    const out = sampleObject(deep, { depth: 2 }) as Record<string, unknown>;
    expect(out.l1).toBeDefined();
    const l1 = out.l1 as Record<string, unknown>;
    expect(l1.l2).toBeDefined();
    const l2 = l1.l2 as Record<string, unknown>;
    expect(l2[SAMPLE_MARKER_TRUNCATED_KIND]).toBe("object");
    expect(l2[SAMPLE_MARKER_TRUNCATED_KEYS]).toBe(1);
  });

  test("arrays beyond array_cap are truncated with a marker", () => {
    const long = Array.from({ length: 250 }, (_, i) => i);
    const out = sampleObject(long, { array_cap: 100 }) as unknown[];
    expect(out.length).toBe(101);
    const tail = out[100] as Record<string, unknown>;
    expect(tail[SAMPLE_MARKER_TRUNCATED_KIND]).toBe("array");
    expect(tail[SAMPLE_MARKER_TRUNCATED_COUNT]).toBe(150);
  });

  test("arrays under array_cap pass through", () => {
    const short = [1, 2, 3];
    expect(sampleObject(short, { array_cap: 100 })).toEqual([1, 2, 3]);
  });

  test("nested array gets truncated at the inner level", () => {
    const inner = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const out = sampleObject({ data: inner }, { array_cap: 5 }) as Record<string, unknown>;
    const arr = out.data as unknown[];
    expect(arr.length).toBe(6);
    expect((arr[5] as Record<string, unknown>)[SAMPLE_MARKER_TRUNCATED_COUNT]).toBe(45);
  });

  test("does not mutate the input", () => {
    const input = { a: [1, 2, 3], b: { c: 4 } };
    const snapshot = JSON.stringify(input);
    sampleObject(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("zero depth still keeps top-level keys but collapses every branch", () => {
    const out = sampleObject({ a: { b: 1 } }, { depth: 1 }) as Record<string, unknown>;
    const a = out.a as Record<string, unknown>;
    expect(a[SAMPLE_MARKER_TRUNCATED_KIND]).toBe("object");
  });
});
