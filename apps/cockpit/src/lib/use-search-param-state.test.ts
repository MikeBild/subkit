import { describe, expect, test } from "bun:test";
import { searchWithParam } from "./use-search-param-state";

describe("list filters in the address", () => {
  test("a filter joins the other parameters and its default leaves the address", () => {
    expect(searchWithParam("?category=devops", "q", "brief", "")).toBe("?category=devops&q=brief");
    expect(searchWithParam("?category=devops&q=brief", "q", "", "")).toBe("?category=devops");
    expect(searchWithParam("?group=kind", "group", "all", "all")).toBe("");
    expect(searchWithParam("", "origin", "llm", "all")).toBe("?origin=llm");
    expect(searchWithParam("?category=a", "category", null, "all")).toBe("");
  });

  test("values are encoded, never passed through as raw text", () => {
    expect(searchWithParam("", "q", "2026 & co", "")).toBe("?q=2026+%26+co");
  });
});
