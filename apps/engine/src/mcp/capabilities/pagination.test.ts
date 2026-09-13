import { describe, expect, test } from "bun:test";

import { __test__, paginate } from "./pagination.ts";

describe("mcp pagination helper", () => {
  test("returns stable nextCursor values and resumes by kind", () => {
    const first = paginate("tools/list", [1, 2, 3, 4, 5], undefined, 2);
    expect(first.page).toEqual([1, 2]);
    expect(typeof first.nextCursor).toBe("string");

    const second = paginate("tools/list", [1, 2, 3, 4, 5], first.nextCursor, 2);
    expect(second.page).toEqual([3, 4]);
    expect(typeof second.nextCursor).toBe("string");

    const third = paginate("tools/list", [1, 2, 3, 4, 5], second.nextCursor, 2);
    expect(third.page).toEqual([5]);
    expect(third.nextCursor).toBeUndefined();
  });

  test("rejects malformed and cross-operation cursors", () => {
    expect(() => paginate("resources/list", [], "not-base64-json")).toThrow(
      /Invalid pagination cursor for resources\/list/,
    );
    const cursor = __test__.encodeCursor({ kind: "prompts/list", offset: 1 });
    expect(() => paginate("tools/list", [], cursor)).toThrow(
      /Invalid pagination cursor for tools\/list/,
    );
  });
});
