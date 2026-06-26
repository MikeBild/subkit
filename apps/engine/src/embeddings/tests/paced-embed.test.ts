// Backfill pacing logic — deterministic, no model load.
//
// embedChunkTextsPaced splits a batch into sub-batches and yields a macrotask
// between them so a backfill never stalls the event loop on one synchronous
// WASM block. Here we pin the slicing, ordering, yield placement and
// null-alignment with INJECTED embed/yield so the contract cannot regress
// without a real model.

import { describe, expect, test } from "bun:test";
import { EMBED_SUBBATCH, embedChunkTextsPaced } from "../local-provider.ts";

/** A vector stand-in keyed by index so we can assert order is preserved. */
const vec = (i: number): number[] => [i];

describe("embedChunkTextsPaced", () => {
  test("splits into sub-batches of subBatch and concatenates in order", async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const calls: number[] = [];
    let next = 0;
    const embed = async (slice: string[]): Promise<(number[] | null)[]> => {
      calls.push(slice.length);
      return slice.map(() => vec(next++));
    };
    const out = await embedChunkTextsPaced(texts, { subBatch: 4, embed, yield: async () => {} });

    // N=10, subBatch 4 → ceil(10/4)=3 calls with slice lengths [4,4,2].
    expect(calls).toEqual([4, 4, 2]);
    // Output concatenates the sub-batch outputs in original order.
    expect(out).toEqual(Array.from({ length: 10 }, (_, i) => vec(i)));
  });

  test("yields strictly between blocks — never leading or trailing", async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const order: string[] = [];
    const embed = async (slice: string[]): Promise<(number[] | null)[]> => {
      order.push("embed");
      return slice.map(() => null);
    };
    const onYield = async (): Promise<void> => {
      order.push("yield");
    };
    await embedChunkTextsPaced(texts, { subBatch: 4, embed, yield: onYield });

    // ceil(10/4)-1 = 2 yields, interleaved between the 3 embeds.
    expect(order.filter((o) => o === "yield").length).toBe(2);
    expect(order).toEqual(["embed", "yield", "embed", "yield", "embed"]);
  });

  test("null-aligned: all-null embed → length-N all-null array", async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const embed = async (slice: string[]): Promise<(number[] | null)[]> => slice.map(() => null);
    const out = await embedChunkTextsPaced(texts, { subBatch: 4, embed, yield: async () => {} });

    expect(out.length).toBe(10);
    expect(out.every((v) => v === null)).toBe(true);
  });

  test("null-aligned: mixed nulls preserve their positions", async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `t${i}`);
    let idx = 0;
    // Embed every other text; null otherwise — positions must survive slicing.
    const embed = async (slice: string[]): Promise<(number[] | null)[]> =>
      slice.map(() => (idx++ % 2 === 0 ? vec(idx) : null));
    const out = await embedChunkTextsPaced(texts, { subBatch: 4, embed, yield: async () => {} });

    expect(out.length).toBe(6);
    expect(out.map((v) => v === null)).toEqual([false, true, false, true, false, true]);
  });

  test("empty input → [], embed and yield never called", async () => {
    let embedCalls = 0;
    let yieldCalls = 0;
    const out = await embedChunkTextsPaced([], {
      subBatch: 4,
      embed: async (s) => {
        embedCalls++;
        return s.map(() => null);
      },
      yield: async () => {
        yieldCalls++;
      },
    });
    expect(out).toEqual([]);
    expect(embedCalls).toBe(0);
    expect(yieldCalls).toBe(0);
  });

  test("N <= subBatch → exactly one embed call and zero yields", async () => {
    const texts = ["a", "b", "c"]; // 3 <= subBatch 4
    let embedCalls = 0;
    let yieldCalls = 0;
    const out = await embedChunkTextsPaced(texts, {
      subBatch: 4,
      embed: async (s) => {
        embedCalls++;
        return s.map((_, i) => vec(i));
      },
      yield: async () => {
        yieldCalls++;
      },
    });
    expect(embedCalls).toBe(1);
    expect(yieldCalls).toBe(0);
    expect(out.length).toBe(3);
  });

  test("default subBatch is EMBED_SUBBATCH (4)", () => {
    expect(EMBED_SUBBATCH).toBe(4);
  });

  // The default yield uses a macrotask (setTimeout(0)) so the event loop
  // services pending I/O/timers between blocks (a microtask would not) — see
  // yieldToEventLoop in local-provider.ts. That runtime behaviour is asserted
  // in prod (event_loop.lag stays low during backfill), not here: a unit test
  // for it would need a raw setTimeout, which the determinism lint forbids.
});
