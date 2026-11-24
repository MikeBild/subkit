import { afterEach, describe, expect, test } from "bun:test";
import { createLogRing } from "../log-ring.ts";

describe("createLogRing", () => {
  let ring = createLogRing(10);

  afterEach(() => {
    ring = createLogRing(10);
  });

  test("records entries and tails newest-first by default", () => {
    for (let i = 0; i < 5; i++) {
      ring.record({
        ts: 1000 + i,
        level: "info",
        module: "test",
        action: `evt${i}`,
        msg: `m${i}`,
        fields: {},
      });
    }
    const tail = ring.tail();
    expect(tail.length).toBe(5);
    expect(tail[0]!.action).toBe("evt4");
    expect(tail.at(-1)!.action).toBe("evt0");
  });

  test("evicts oldest entries when over capacity", () => {
    for (let i = 0; i < 15; i++) {
      ring.record({
        ts: i,
        level: "info",
        fields: {},
      });
    }
    expect(ring.size()).toBe(10);
    const oldest = ring.tail({ since_ms: 0, limit: 100 })[0]!;
    expect(oldest.ts).toBe(5);
  });

  test("since_ms returns chronological slice (oldest first)", () => {
    for (let i = 0; i < 5; i++) {
      ring.record({ ts: 100 + i, level: "info", fields: {} });
    }
    const slice = ring.tail({ since_ms: 102 });
    expect(slice.map((e) => e.ts)).toEqual([102, 103, 104]);
  });

  test("since_ms page never splits entries that share the last millisecond", () => {
    for (const action of ["a", "b", "c"])
      ring.record({ ts: 500, level: "info", action, fields: {} });
    ring.record({ ts: 501, level: "info", action: "d", fields: {} });

    const firstPage = ring.tail({ since_ms: 500, limit: 1 });
    expect(firstPage.map((e) => e.action)).toEqual(["a", "b", "c"]);
    const nextPage = ring.tail({ since_ms: firstPage.at(-1)!.ts + 1, limit: 1 });
    expect(nextPage.map((e) => e.action)).toEqual(["d"]);
  });

  test("module + action + min_level filtering", () => {
    ring.record({ ts: 1, level: "info", module: "a", action: "x", fields: {} });
    ring.record({ ts: 2, level: "warn", module: "a", action: "y", fields: {} });
    ring.record({ ts: 3, level: "error", module: "b", action: "x", fields: {} });

    expect(ring.tail({ module: "a" }).length).toBe(2);
    expect(ring.tail({ action: "x" }).length).toBe(2);
    expect(ring.tail({ min_level: "warn" }).length).toBe(2);
    expect(ring.tail({ module: "a", min_level: "warn" }).length).toBe(1);
  });

  test("subscribers receive each new entry once and can unsubscribe", () => {
    const seen: number[] = [];
    const unsub = ring.subscribe((e) => seen.push(e.ts));
    ring.record({ ts: 1, level: "info", fields: {} });
    ring.record({ ts: 2, level: "info", fields: {} });
    unsub();
    ring.record({ ts: 3, level: "info", fields: {} });
    expect(seen).toEqual([1, 2]);
  });
});
