import { describe, expect, test } from "bun:test";
import { type ScrollBox, scrollRoot, wantsNextPage } from "./infinite-scroll";

interface Box extends ScrollBox {
  name: string;
  overflowY: string;
  parentElement: Box | null;
}

function box(
  name: string,
  overflowY: string,
  scrollHeight: number,
  clientHeight: number,
  parentElement: Box | null,
): Box {
  return { name, overflowY, scrollHeight, clientHeight, parentElement };
}

const overflowOf = (candidate: Box) => candidate.overflowY;

describe("scroll root", () => {
  test("the nearest ancestor that scrolls is the root", () => {
    const page = box("page", "auto", 3000, 900, null);
    const table = box("table", "auto", 2000, 600, page);
    const sentinel = box("sentinel", "visible", 44, 44, table);
    expect(scrollRoot(sentinel, overflowOf)?.name).toBe("table");
  });

  test("a container that grows with its rows is skipped for the one that scrolls", () => {
    const page = box("page", "auto", 3000, 900, null);
    const table = box("table", "auto", 1200, 1200, page);
    const sentinel = box("sentinel", "visible", 44, 44, table);
    expect(scrollRoot(sentinel, overflowOf)?.name).toBe("page");
  });

  test("without any scrolling ancestor the viewport is the root", () => {
    const shell = box("shell", "visible", 500, 900, null);
    const table = box("table", "hidden", 500, 500, shell);
    const sentinel = box("sentinel", "visible", 44, 44, table);
    expect(scrollRoot(sentinel, overflowOf)).toBeNull();
  });
});

describe("next page", () => {
  const idle = { hasNextPage: true, isFetchingNextPage: false };

  test("a sentinel in reach loads the next page", () => {
    expect(wantsNextPage([{ isIntersecting: true }], idle)).toBe(true);
  });

  test("a sentinel that still shows after a page arrived keeps loading until the list fills", () => {
    const afterEachPage = [1, 2, 3].map(() => wantsNextPage([{ isIntersecting: true }], idle));
    expect(afterEachPage).toEqual([true, true, true]);
  });

  test("an out-of-reach or hidden sentinel, a running fetch, or the end never loads", () => {
    expect(wantsNextPage([{ isIntersecting: false }], idle)).toBe(false);
    expect(wantsNextPage([], idle)).toBe(false);
    expect(
      wantsNextPage([{ isIntersecting: true }], { hasNextPage: true, isFetchingNextPage: true }),
    ).toBe(false);
    expect(
      wantsNextPage([{ isIntersecting: true }], { hasNextPage: false, isFetchingNextPage: false }),
    ).toBe(false);
  });
});
