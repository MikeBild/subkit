import { describe, expect, test } from "bun:test";
import { tableColumnWidths } from "./data-table";
import {
  keepSelectable,
  selectionState,
  toggleAllSelected,
  toggleSelected,
} from "./table-selection";

describe("row selection in a table", () => {
  test("reads none, some or all of the selectable rows", () => {
    expect(selectionState(["a", "b"], new Set())).toBe("none");
    expect(selectionState(["a", "b"], new Set(["a"]))).toBe("some");
    expect(selectionState(["a", "b"], new Set(["a", "b", "gone"]))).toBe("all");
    expect(selectionState([], new Set())).toBe("none");
  });

  test("select all adds every selectable row and clears them when all were chosen", () => {
    expect([...toggleAllSelected(["a", "b"], new Set(["a"]))].sort()).toEqual(["a", "b"]);
    expect([...toggleAllSelected(["a", "b"], new Set(["a", "b"]))]).toEqual([]);
  });

  test("one box changes only its own row", () => {
    expect([...toggleSelected("b", new Set(["a"]), true)].sort()).toEqual(["a", "b"]);
    expect([...toggleSelected("a", new Set(["a", "b"]), false)]).toEqual(["b"]);
  });

  test("a row that can no longer be chosen leaves the selection", () => {
    expect([...keepSelectable(["b"], new Set(["a", "b"]))]).toEqual(["b"]);
  });

  test("the selection column reserves its own width", () => {
    expect(tableColumnWidths(["w-[50%]", "w-[50%]"], { actions: false, select: true })).toEqual([
      "calc(50.0000cqw - 1.3750rem)",
      "calc(50.0000cqw - 1.3750rem)",
    ]);
  });
});
