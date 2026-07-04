import { describe, expect, it } from "bun:test";
import { truncateEnd, truncateMiddle } from "../repl/truncate.ts";

describe("truncateEnd", () => {
  it("returns the original string when it fits", () => {
    expect(truncateEnd("hello", 10)).toBe("hello");
    expect(truncateEnd("hello", 5)).toBe("hello");
  });
  it("appends an ellipsis when too long", () => {
    expect(truncateEnd("hello world", 8)).toBe("hello w…");
  });
  it("collapses to the ellipsis at max=1", () => {
    expect(truncateEnd("hello", 1)).toBe("…");
  });
  it("returns empty at max<=0", () => {
    expect(truncateEnd("hello", 0)).toBe("");
    expect(truncateEnd("hello", -3)).toBe("");
  });
  it("counts code points, not utf-16 units", () => {
    expect(truncateEnd("a😀b😀c", 10)).toBe("a😀b😀c");
  });
});

describe("truncateMiddle", () => {
  it("returns the original string when it fits", () => {
    expect(truncateMiddle("abc", 10)).toBe("abc");
  });
  it("inserts the ellipsis in the middle", () => {
    expect(truncateMiddle("abcdefghij", 5)).toBe("ab…ij");
  });
  it("biases the head when max-1 is odd", () => {
    expect(truncateMiddle("abcdefghij", 6)).toBe("abc…ij");
  });
  it("returns just the ellipsis at max<=2", () => {
    expect(truncateMiddle("abcdef", 1)).toBe("…");
    expect(truncateMiddle("abcdef", 2)).toBe("…");
  });
  it("counts code points for emoji", () => {
    // 5 code points; max=4 → head=2 + … + tail=1 → "a😀…c"
    expect(truncateMiddle("a😀b😀c", 4)).toBe("a😀…c");
  });
});
