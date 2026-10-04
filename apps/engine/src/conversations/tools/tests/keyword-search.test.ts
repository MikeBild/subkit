import { describe, expect, test } from "bun:test";
import { keywordSearch } from "../keyword-search.ts";

const items = [
  { id: "a", txt: "stripe customers list" },
  { id: "b", txt: "hubspot contacts list" },
  { id: "c", txt: "stripe charges create" },
];

describe("keywordSearch", () => {
  test("returns all items for `*` / empty", () => {
    expect(keywordSearch("*", items, (i) => i.txt).length).toBe(3);
    expect(keywordSearch("", items, (i) => i.txt).length).toBe(3);
    expect(keywordSearch("all", items, (i) => i.txt).length).toBe(3);
  });

  test("orders by keyword overlap score", () => {
    const ranked = keywordSearch("stripe customers", items, (i) => i.txt);
    expect(ranked[0]?.id).toBe("a");
    expect(ranked[1]?.id).toBe("c");
    expect(ranked.find((i) => i.id === "b")).toBeUndefined();
  });

  test("falls back to all items when nothing matches (default)", () => {
    const ranked = keywordSearch("nothing", items, (i) => i.txt);
    expect(ranked.length).toBe(3);
  });

  test("returns [] when fallbackOnNoMatch=false", () => {
    const ranked = keywordSearch("nothing", items, (i) => i.txt, {
      fallbackOnNoMatch: false,
    });
    expect(ranked.length).toBe(0);
  });
});
