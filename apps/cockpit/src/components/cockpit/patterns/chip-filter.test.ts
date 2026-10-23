import { describe, expect, test } from "bun:test";
import { visibleChipOptions } from "./chip-filter";

const options = Array.from({ length: 12 }, (_, index) => ({
  value: `c${index}`,
  label: `C${index}`,
  count: 12 - index,
}));

describe("chip filter", () => {
  test("shows the leading chips and counts the rest behind more", () => {
    const { shown, hidden } = visibleChipOptions(options, "all", false, 8);
    expect(shown.map((option) => option.value)).toEqual(options.slice(0, 8).map((o) => o.value));
    expect(hidden).toBe(4);
  });

  test("a selected chip beyond the limit stays visible", () => {
    const { shown, hidden } = visibleChipOptions(options, "c10", false, 8);
    expect(shown.at(-1)?.value).toBe("c10");
    expect(hidden).toBe(3);
  });

  test("expanded or short lists show every chip", () => {
    expect(visibleChipOptions(options, "all", true, 8).hidden).toBe(0);
    expect(visibleChipOptions(options.slice(0, 3), "all", false, 8).shown).toHaveLength(3);
  });
});
