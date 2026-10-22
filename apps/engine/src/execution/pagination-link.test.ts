import { describe, expect, test } from "bun:test";
import { parseLinkHeader } from "../connectors/health.ts";
import { makeStrategy, PaginationError, type PaginationSpec } from "./pagination.ts";

const API = "https://api.github.com";

const issuesSpec: PaginationSpec = {
  strategy: "link",
  link_params: ["after", "page"],
  limit_param: "per_page",
  page_size: 100,
  max_pages: 20,
};

function issuesStrategy(spec: PaginationSpec = issuesSpec) {
  return makeStrategy(spec, {
    baseUrl: new URL(
      `${API}/repos/MikeBild/subkit/issues?state=all&sort=updated&direction=desc&since=2026-10-15T00%3A00%3A00Z`,
    ),
    baseQuery: {},
  });
}

function link(...entries: Array<[string, string]>): Record<string, string> {
  return { link: entries.map(([url, rel]) => `<${url}>; rel="${rel}"`).join(", ") };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof PaginationError ? err.code : `unexpected:${String(err)}`;
  }
}

const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe("parseLinkHeader", () => {
  test("reads GitHub next and last relations", () => {
    expect(
      parseLinkHeader(
        `<${API}/repositories/1/issues?per_page=100&page=2>; rel="next", <${API}/repositories/1/issues?per_page=100&page=5>; rel="last"`,
      ),
    ).toEqual([
      { url: `${API}/repositories/1/issues?per_page=100&page=2`, rels: ["next"] },
      { url: `${API}/repositories/1/issues?per_page=100&page=5`, rels: ["last"] },
    ]);
  });

  test("reads cursor links with after and page and prev-only last pages", () => {
    const parsed = parseLinkHeader(
      `<${API}/repositories/1/issues?per_page=100&after=Y3Vyc29yOnYyOpLPAAABk&page=2>; rel="next"`,
    );
    expect(parsed[0]?.rels).toEqual(["next"]);
    expect(parseLinkHeader(`<${API}/x?page=1>; rel="prev"`)).toEqual([
      { url: `${API}/x?page=1`, rels: ["prev"] },
    ]);
    expect(parseLinkHeader(undefined)).toEqual([]);
    expect(parseLinkHeader("garbage")).toEqual([]);
  });

  test("keeps multi-token relations", () => {
    expect(parseLinkHeader(`<https://a.example/v2>; rel="successor-version latest"`)).toEqual([
      { url: "https://a.example/v2", rels: ["successor-version", "latest"] },
    ]);
  });
});

describe("link pagination strategy", () => {
  test("first page carries the authored query plus the page size", () => {
    const first = issuesStrategy().next(null, 0, {});
    expect(first.done).toBe(false);
    const url = new URL(first.url);
    expect(url.pathname).toBe("/repos/MikeBild/subkit/issues");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("since")).toBe("2026-10-15T00:00:00Z");
    expect(url.searchParams.has("page")).toBe(false);
  });

  test("follows rel=next on the authored path and carries only the link parameters", () => {
    const strategy = issuesStrategy();
    strategy.next(null, 0, {});
    const next = strategy.next(
      page(100),
      1,
      link(
        [
          `${API}/repositories/123/issues?state=all&sort=updated&direction=desc&since=2026-10-15T00%3A00%3A00Z&per_page=100&after=Y3Vyc29yOnYyOpLPAAABk&page=2`,
          "next",
        ],
        [`${API}/repositories/123/issues?per_page=100&page=1`, "prev"],
      ),
    );
    const url = new URL(next.url);
    expect(url.pathname).toBe("/repos/MikeBild/subkit/issues");
    expect(url.searchParams.get("after")).toBe("Y3Vyc29yOnYyOpLPAAABk");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("state")).toBe("all");

    const third = strategy.next(
      page(100),
      2,
      link([`${API}/repositories/123/issues?per_page=100&after=Y3Vyc29yOnYyOpLPAAACk`, "next"]),
    );
    const thirdUrl = new URL(third.url);
    expect(thirdUrl.searchParams.get("after")).toBe("Y3Vyc29yOnYyOpLPAAACk");
    expect(thirdUrl.searchParams.has("page")).toBe(false);
  });

  test("ends when no next relation is present", () => {
    const strategy = issuesStrategy();
    strategy.next(null, 0, {});
    expect(
      strategy.next(page(37), 1, link([`${API}/repositories/123/issues?page=1`, "prev"])).done,
    ).toBe(true);
    expect(strategy.next(page(37), 1, {}).done).toBe(true);
  });

  test("refuses a next link on a foreign origin", () => {
    const strategy = issuesStrategy();
    strategy.next(null, 0, {});
    expect(
      codeOf(() =>
        strategy.next(page(100), 1, link(["https://evil.example/issues?page=2", "next"])),
      ),
    ).toBe("pagination_link_foreign");
  });

  test("refuses unknown keys, changed authored values and unsafe cursor values", () => {
    for (const href of [
      `${API}/repositories/1/issues?page=2&access_token=x`,
      `${API}/repositories/1/issues?page=2&state=open`,
      `${API}/repositories/1/issues?after=${encodeURIComponent("a b")}`,
      `${API}/repositories/1/issues?after=${"a".repeat(513)}`,
      `${API}/repositories/1/issues?page=2&page=3`,
    ]) {
      const strategy = issuesStrategy();
      strategy.next(null, 0, {});
      expect(codeOf(() => strategy.next(page(100), 1, link([href, "next"])))).toBe(
        "pagination_link_unsupported",
      );
    }
  });

  test("reports a clamped page size as a short page", () => {
    const strategy = issuesStrategy();
    strategy.next(null, 0, {});
    expect(
      codeOf(() =>
        strategy.next(
          page(50),
          1,
          link([`${API}/repositories/1/issues?per_page=50&page=2`, "next"]),
        ),
      ),
    ).toBe("pagination_short_page");
  });

  test("refuses a repeated parameter tuple, also when it is not adjacent", () => {
    const strategy = issuesStrategy();
    strategy.next(null, 0, {});
    strategy.next(page(100), 1, link([`${API}/r?page=2`, "next"]));
    strategy.next(page(100), 2, link([`${API}/r?page=3`, "next"]));
    expect(codeOf(() => strategy.next(page(100), 3, link([`${API}/r?page=2`, "next"])))).toBe(
      "pagination_link_loop",
    );
    const looping = issuesStrategy();
    looping.next(null, 0, {});
    expect(codeOf(() => looping.next(page(100), 1, link([`${API}/r?per_page=100`, "next"])))).toBe(
      "pagination_link_loop",
    );
  });

  test("merges items from items_path", () => {
    const strategy = makeStrategy(
      {
        strategy: "link",
        link_params: ["page"],
        limit_param: "per_page",
        page_size: 100,
        items_path: "workflow_runs",
      },
      { baseUrl: new URL(`${API}/repos/a/b/actions/runs`), baseQuery: {} },
    );
    expect(strategy.merge([], { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] })).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });
});

describe("short page guard for page and offset strategies", () => {
  test("a short page that still announces rel=next fails closed", () => {
    const strategy = makeStrategy(
      {
        strategy: "page",
        page_size: 100,
        page_param: "page",
        limit_param: "per_page",
        start_page: 1,
      },
      { baseUrl: new URL(`${API}/repos/a/b/commits`), baseQuery: {} },
    );
    strategy.next(null, 0, {});
    expect(
      codeOf(() => strategy.next(page(30), 1, link([`${API}/repos/a/b/commits?page=2`, "next"]))),
    ).toBe("pagination_short_page");
  });

  test("a short page without rel=next ends as before", () => {
    const strategy = makeStrategy(
      { strategy: "offset", page_size: 10, offset_param: "offset", limit_param: "limit" },
      { baseUrl: new URL("https://example.test/rows"), baseQuery: {} },
    );
    strategy.next(null, 0, {});
    expect(strategy.next(page(3), 1, {}).done).toBe(true);
    expect(strategy.next(page(3), 1).done).toBe(true);
  });
});
