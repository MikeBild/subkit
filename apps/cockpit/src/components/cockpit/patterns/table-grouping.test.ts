import { describe, expect, test } from "bun:test";
import type { ListReturnStore } from "./list-return";
import {
  orderGroupedRows,
  readCollapsedGroups,
  rowsByGroup,
  toggleGroup,
  writeCollapsedGroups,
} from "./table-grouping";

type Row = { id: string; group: string; urgent?: boolean };

function memory(): ListReturnStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const rows: Row[] = [
  { id: "1", group: "b" },
  { id: "2", group: "a" },
  { id: "3", group: "b", urgent: true },
  { id: "4", group: "a" },
];

describe("table grouping", () => {
  test("groups stay contiguous and keep the server order inside a group", () => {
    const ordered = orderGroupedRows(rows, { getKey: (row) => row.group });
    expect(ordered.map((row) => row.id)).toEqual(["2", "4", "1", "3"]);
  });

  test("rows that need attention lead their group without reordering the rest", () => {
    const ordered = orderGroupedRows(rows, {
      getKey: (row) => row.group,
      rankWithin: (row) => (row.urgent ? 0 : 1),
    });
    expect(ordered.map((row) => row.id)).toEqual(["2", "4", "3", "1"]);
  });

  test("a custom key order decides the group sequence", () => {
    const ordered = orderGroupedRows(rows, {
      getKey: (row) => row.group,
      compareKeys: (left, right) => right.localeCompare(left),
    });
    expect(ordered.map((row) => row.group)).toEqual(["b", "b", "a", "a"]);
  });

  test("members are collected per group", () => {
    const groups = rowsByGroup(rows, (row) => row.group);
    expect(groups.get("a")?.map((row) => row.id)).toEqual(["2", "4"]);
    expect(groups.get("b")?.length).toBe(2);
  });

  test("collapsed groups survive a return to the list and clear when all are open", () => {
    const store = memory();
    const collapsed = toggleGroup(new Set(), "ai");
    writeCollapsedGroups("/workflows:category", collapsed, store);
    expect([...readCollapsedGroups("/workflows:category", store)]).toEqual(["ai"]);
    expect(readCollapsedGroups("/connectors:category", store).size).toBe(0);
    writeCollapsedGroups("/workflows:category", toggleGroup(collapsed, "ai"), store);
    expect(store.data.size).toBe(0);
  });

  test("a damaged stored value reads as nothing collapsed", () => {
    const store = memory();
    store.setItem("sk.list-groups:/files:category", "{not json");
    expect(readCollapsedGroups("/files:category", store).size).toBe(0);
    store.setItem("sk.list-groups:/files:category", JSON.stringify(["ok", 3]));
    expect([...readCollapsedGroups("/files:category", store)]).toEqual(["ok"]);
  });
});
