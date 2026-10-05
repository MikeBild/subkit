import { describe, expect, test } from "bun:test";
import {
  type CursorPage,
  listPagePath,
  listQueryKey,
  nextPageParam,
  type PageParam,
} from "./use-infinite-list";

const ROWS = Array.from({ length: 61 }, (_, index) => `row-${index + 1}`);

function offsetEngine(path: string): CursorPage<string> {
  const query = new URL(path, "http://engine.test").searchParams;
  const limit = Number(query.get("limit"));
  const offset = Number(query.get("offset") ?? 0);
  return { items: ROWS.slice(offset, offset + limit), total: ROWS.length };
}

function cursorEngine(path: string): CursorPage<string> {
  const query = new URL(path, "http://engine.test").searchParams;
  const limit = Number(query.get("limit"));
  const after = query.get("cursor");
  const start = after ? ROWS.indexOf(after) + 1 : 0;
  const items = ROWS.slice(start, start + limit);
  const more = start + limit < ROWS.length;
  return { items, next_cursor: more ? (items.at(-1) ?? null) : null };
}

function loadAll(engine: (path: string) => CursorPage<string>, limit: number) {
  const pages: CursorPage<string>[] = [];
  const requested: string[] = [];
  let start: PageParam = null;
  do {
    const path = listPagePath("/v1/workflows", { sort: "updated_at" }, limit, start);
    requested.push(path);
    pages.push(engine(path));
    start = nextPageParam(pages);
  } while (start !== null && requested.length < 20);
  return { items: pages.flatMap((page) => page.items), requested };
}

describe("infinite list paging", () => {
  test("offset paging loads every row up to the engine's total, then stops", () => {
    const { items, requested } = loadAll(offsetEngine, 25);
    expect(items).toEqual(ROWS);
    expect(requested).toHaveLength(3);
    expect(requested[1]).toContain("offset=25");
    expect(requested[2]).toContain("offset=50");
    expect(requested.every((path) => path.includes("sort=updated_at"))).toBe(true);
  });

  test("cursor paging follows next_cursor until the engine has none", () => {
    const { items, requested } = loadAll(cursorEngine, 25);
    expect(items).toEqual(ROWS);
    expect(requested).toHaveLength(3);
    expect(requested[0]).not.toContain("cursor=");
    expect(requested[1]).toContain("cursor=row-25");
  });

  test("an empty page or a list without a total never asks again", () => {
    expect(nextPageParam([{ items: [], total: 10 }])).toBeNull();
    expect(nextPageParam([{ items: ["a"] }])).toBeNull();
    expect(nextPageParam([])).toBeNull();
  });

  test("blank filters stay out of the address", () => {
    const path = listPagePath("/v1/connectors", { q: "", status: null, sort: "name" }, 25, null);
    expect(path).toBe("/v1/connectors?sort=name&limit=25");
  });

  test("catalog lists share one invalidation root", () => {
    expect(listQueryKey("/v1/workflows", {})[0]).toBe("catalog");
    expect(listQueryKey("/v1/audit-log", {})[0]).toBe("audit");
  });
});
