import { describe, expect, test } from "bun:test";
import { rankEntries } from "../repl/inline-history-search.tsx";

describe("rankEntries", () => {
  test("empty query returns all entries most-recent-first", () => {
    expect(rankEntries(["a", "b", "c"], "")).toEqual(["c", "b", "a"]);
  });

  test("filters by case-insensitive substring", () => {
    const entries = ["Draft invoice workflow", "schedule cron", "DRAFT step two"];
    expect(rankEntries(entries, "draft")).toEqual(["DRAFT step two", "Draft invoice workflow"]);
  });

  test("earlier match ranks higher than later match", () => {
    const entries = ["xxxrun", "run now", "walk and run"];
    const ranked = rankEntries(entries, "run");
    // `run now` starts with the query — ranks first.
    expect(ranked[0]).toBe("run now");
  });

  test("non-matching entries are excluded", () => {
    const ranked = rankEntries(["foo", "bar", "baz"], "xyz");
    expect(ranked).toEqual([]);
  });
});
