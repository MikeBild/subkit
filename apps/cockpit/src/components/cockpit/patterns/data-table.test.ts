import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { opensRow, rowLinkColumn } from "./data-table";

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

describe("a click opens its row only when it happened inside the row", () => {
  const { window } = new JSDOM(
    '<table><tr id="row"><td><span id="cell">Name</span><button id="menu">⋯</button></td></tr></table><div role="menu" id="portal"><div role="menuitem" id="item"><span id="label">Löschen</span></div></div>',
  );
  const byId = (id: string) => window.document.getElementById(id) as Element;
  const click = (id: string) => opensRow({ target: byId(id), currentTarget: byId("row") });

  test("a plain cell opens the row", () => {
    expect(click("cell")).toBe(true);
  });

  test("a control in the row keeps the click for itself", () => {
    expect(click("menu")).toBe(false);
  });

  test("a menu item rendered in a portal never opens the row it belongs to", () => {
    expect(click("item")).toBe(false);
    expect(click("label")).toBe(false);
  });
});
