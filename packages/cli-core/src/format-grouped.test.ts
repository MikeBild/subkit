// emitGroupedList renders a catalog as titled blocks. The block ORDER is the
// server's (`categories` on the list response) — these tests pin that the
// renderer follows it rather than sorting on its own, and that no row can be
// dropped by a block list that does not mention it.

import { afterEach, describe, expect, test } from "bun:test";
import { emitGroupedList } from "./format.ts";

const originalWrite = process.stdout.write.bind(process.stdout);
let captured = "";

function capture(): void {
  captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
}

afterEach(() => {
  process.stdout.write = originalWrite;
});

const ROWS = [
  { id: "1", name: "A", category: "notion" },
  { id: "2", name: "B", category: "other" },
  { id: "3", name: "C", category: "notion" },
];
const BLOCKS = [
  { category: "notion", count: 2 },
  { category: "other", count: 1 },
];

describe("emitGroupedList", () => {
  test("renders blocks in the server's order with per-block counts", () => {
    capture();
    emitGroupedList(false, ["id", "name"], ROWS, BLOCKS);
    expect(captured).toContain("notion  (2)");
    expect(captured).toContain("other  (1)");
    expect(captured.indexOf("notion")).toBeLessThan(captured.indexOf("other"));
  });

  test("does not re-sort — a server order the renderer disagrees with still wins", () => {
    capture();
    emitGroupedList(false, ["id", "name"], ROWS, [
      { category: "other", count: 1 },
      { category: "notion", count: 2 },
    ]);
    expect(captured.indexOf("other")).toBeLessThan(captured.indexOf("notion"));
  });

  test("never drops a row whose block the server did not announce", () => {
    capture();
    emitGroupedList(false, ["id", "name"], ROWS, [{ category: "notion", count: 2 }]);
    expect(captured).toContain("(ungrouped)  (1)");
    expect(captured).toContain("B");
  });

  test("skips an announced block that has no rows on this page", () => {
    capture();
    emitGroupedList(false, ["id", "name"], ROWS, [
      { category: "notion", count: 2 },
      { category: "empty-block", count: 0 },
      { category: "other", count: 1 },
    ]);
    expect(captured).not.toContain("empty-block");
  });

  test("JSON output stays flat and unchanged", () => {
    capture();
    emitGroupedList(true, ["id", "name"], ROWS, BLOCKS);
    expect(JSON.parse(captured)).toEqual(ROWS);
  });

  test("reports an empty catalog once, not once per block", () => {
    capture();
    emitGroupedList(false, ["id", "name"], [], BLOCKS);
    expect(captured).toBe("(no rows)\n");
  });
});
