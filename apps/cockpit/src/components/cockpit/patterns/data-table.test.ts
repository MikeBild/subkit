import { describe, expect, test } from "bun:test";
import { rowLinkColumn } from "./data-table";

describe("the column that carries a row's link", () => {
  const name = { id: "name" };
  const status = { id: "status" };
  const usedBy = { id: "used_by", interactive: true };

  test("is the naming column while it is shown", () => {
    expect(rowLinkColumn([name, status, usedBy], "name")).toBe("name");
    expect(rowLinkColumn([name, status])).toBe("name");
  });

  test("a naming cell that places the link itself keeps it, links of its own or not", () => {
    expect(rowLinkColumn([{ id: "name", interactive: true, ownsRowLink: true }], "name")).toBe(
      "name",
    );
  });

  test("moves only to a column without links of its own when the name is hidden", () => {
    expect(rowLinkColumn([usedBy, status], "name")).toBe("status");
    expect(rowLinkColumn([usedBy, status])).toBe("status");
  });

  test("is absent when every shown column holds links of its own", () => {
    expect(rowLinkColumn([usedBy], "name")).toBeUndefined();
    expect(rowLinkColumn([], "name")).toBeUndefined();
  });
});
