import { describe, expect, it } from "bun:test";
import {
  categoryCounts,
  columnFits,
  columnMask,
  createdByMatches,
  dayGroup,
  hideableColumns,
  legacySearch,
  listCategory,
  nextSort,
  sortRows,
  sortValueOf,
  toggleColumn,
  withCategory,
} from "./list-model";

describe("list model", () => {
  const rows = [
    { n: "beta", at: 2 },
    { n: "Alpha", at: null },
    { n: "gamma", at: 1 },
  ];

  it("sorts text without case and numbers by value, empty values last", () => {
    expect(sortRows(rows, (r) => r.n, "asc").map((r) => r.n)).toEqual(["Alpha", "beta", "gamma"]);
    expect(sortRows(rows, (r) => r.n, "desc").map((r) => r.n)).toEqual(["gamma", "beta", "Alpha"]);
    expect(sortRows(rows, (r) => r.at, "asc").map((r) => r.n)).toEqual(["gamma", "beta", "Alpha"]);
    expect(sortRows(rows, (r) => r.at, "desc").map((r) => r.n)).toEqual(["beta", "gamma", "Alpha"]);
  });

  it("keeps the server order without a sort column", () => {
    expect(sortRows(rows, null, "asc")).toEqual(rows);
  });

  it("a header click sorts ascending, then descending, then not at all", () => {
    expect(nextSort({ key: "", order: "asc" }, "name")).toEqual({ key: "name", order: "asc" });
    expect(nextSort({ key: "name", order: "asc" }, "name")).toEqual({ key: "name", order: "desc" });
    expect(nextSort({ key: "name", order: "desc" }, "name")).toEqual({ key: "", order: "asc" });
    expect(nextSort({ key: "name", order: "desc" }, "date")).toEqual({ key: "date", order: "asc" });
  });

  it("created by tells the assistant from people", () => {
    expect(createdByMatches("llm", "all")).toBe(true);
    expect(createdByMatches("llm", "ai")).toBe(true);
    expect(createdByMatches("human", "ai")).toBe(false);
    expect(createdByMatches("human", "person")).toBe(true);
    expect(createdByMatches(undefined, "person")).toBe(true);
    expect(createdByMatches("llm", "person")).toBe(false);
  });

  it("counts categories, largest first", () => {
    expect(
      categoryCounts([{ category: "b" }, { category: "a" }, { category: "b" }, { category: "" }]),
    ).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("groups by the calendar day in the reader's language", () => {
    expect(dayGroup("2026-11-21T10:00:00Z", "de-DE")).toBe("21.11.2026");
    expect(dayGroup("2026-11-21T10:00:00Z", "en-US")).toBe("Nov 21, 2026");
    expect(dayGroup("nope", "de-DE")).toBe("");
  });

  it("an old full-function link lands on the screen with equivalent filters", () => {
    expect(legacySearch("?view=details", "inbox")).toBe("");
    expect(legacySearch("?view=details&category=ai&q=preis", "sources")).toBe(
      "?category=ai&q=preis",
    );
    expect(legacySearch("?group=state&sort=captured_at&order=desc", "inbox")).toBe(
      "?group=status&sort=created&order=desc",
    );
    expect(legacySearch("?group=health&health=not_ok", "connectors")).toBe(
      "?group=status&health=not_ok",
    );
    expect(legacySearch("?sort=title", "skills")).toBe("?sort=name");
    expect(legacySearch("?sort=updated_at", "connectors")).toBe("?sort=tested");
    expect(legacySearch("?category=ai&sort=name", "files")).toBeNull();
    expect(legacySearch("?view=list", "files")).toBeNull();
  });
});

describe("default category and columns", () => {
  it("opens on the default category until a category is chosen, and all stays all", () => {
    expect(listCategory("", "support")).toBe("support");
    expect(listCategory("all", "support")).toBe("all");
    expect(listCategory("sales", "support")).toBe("sales");
    expect(listCategory("", undefined)).toBe("all");
  });

  it("keeps the chosen category as a chip even when it holds nothing", () => {
    expect(withCategory([["sales", 2]], "support")).toEqual([
      ["sales", 2],
      ["support", 0],
    ]);
    expect(withCategory([["sales", 2]], "sales")).toEqual([["sales", 2]]);
    expect(withCategory([["sales", 2]], "all")).toEqual([["sales", 2]]);
  });

  const columns = [
    { id: "select", label: "" },
    { id: "name", label: "Name" },
    { id: "status", label: "Status" },
    { id: "kind", label: "Kind" },
  ];

  it("the name column takes the free width, low-priority columns give way first", () => {
    expect(
      columnFits([...columns.slice(0, 3), { id: "kind", label: "Kind", priority: "low" }]),
    ).toEqual(["control", "name", "fit", "low"]);
  });

  it("never offers the name column or an unlabeled column for hiding", () => {
    expect(hideableColumns(columns).map((c) => c.id)).toEqual(["status", "kind"]);
  });

  it("toggles a column and keeps the first one visible", () => {
    const hidden = toggleColumn(new Set(), "status");
    expect([...hidden]).toEqual(["status"]);
    expect([...toggleColumn(hidden, "status")]).toEqual([]);
    expect(columnMask(columns, new Set(["select", "name", "status"]))).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });
});

describe("sortValueOf", () => {
  const table = { name: (row: { n: string }) => row.n };

  it("returns the sort function a known key names", () => {
    expect(sortValueOf(table, "name")?.({ n: "x" })).toBe("x");
  });

  it("never hands out a prototype member for a crafted key", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "missing"])
      expect(sortValueOf(table, key)).toBeNull();
  });
});
