import { describe, expect, test } from "bun:test";
import { makeStrategy, paginationSignature } from "./pagination.ts";

const context = {
  baseUrl: new URL("https://example.test/report?fixed=yes"),
  baseQuery: {},
};

describe("pagination strategies", () => {
  test("offset pagination can materialize parameters in a JSON body", () => {
    const strategy = makeStrategy(
      {
        strategy: "offset",
        parameter_location: "body",
        page_size: 2,
        offset_param: "startRow",
        limit_param: "rowLimit",
        items_path: "rows",
      },
      context,
    );

    expect(strategy.next(null, 0)).toEqual({
      url: "https://example.test/report?fixed=yes",
      done: false,
      body_parameters: { startRow: 0, rowLimit: 2 },
    });
    strategy.merge([], { rows: [{ id: 1 }, { id: 2 }] });
    expect(strategy.next({ rows: [{ id: 1 }, { id: 2 }] }, 1).body_parameters).toEqual({
      startRow: 2,
      rowLimit: 2,
    });
    expect(strategy.next({ rows: [{ id: 3 }] }, 2).done).toBe(true);
  });

  test("cursor pagination supports body parameters and bare response paths", () => {
    const strategy = makeStrategy(
      {
        strategy: "cursor",
        parameter_location: "body",
        cursor_request_param: "pageToken",
        cursor_response_path: "nextPageToken",
        page_size: 100,
        limit_param: "pageSize",
        items_path: "rows",
      },
      context,
    );

    expect(strategy.next(null, 0).body_parameters).toEqual({ pageSize: 100 });
    const response = { rows: [{ id: 1 }], nextPageToken: "next-1" };
    expect(strategy.next(response, 1).body_parameters).toEqual({
      pageToken: "next-1",
      pageSize: 100,
    });
    expect(strategy.next({ rows: [] }, 2).done).toBe(true);
  });

  test("page output mode preserves ordered response bodies without changing termination", () => {
    const strategy = makeStrategy(
      {
        strategy: "offset",
        page_size: 2,
        offset_param: "startRow",
        limit_param: "rowLimit",
        items_path: "rows",
        output_mode: "pages",
      },
      context,
    );
    const first = { rows: [{ id: 1 }, { id: 2 }], metadata: { source: "raw-1" } };
    const last = { rows: [{ id: 3 }], metadata: { source: "raw-2" } };
    const output: unknown[] = [];

    strategy.merge(output, first);
    expect(strategy.next(first, 1).done).toBe(false);
    strategy.merge(output, last);
    expect(strategy.next(last, 2).done).toBe(true);
    expect(output).toEqual([first, last]);
  });

  test("page pagination reads the configured items path when an empty array precedes it", () => {
    const strategy = makeStrategy(
      {
        strategy: "page",
        page_param: "page",
        limit_param: "per_page",
        page_size: 50,
        start_page: 1,
        items_path: "result",
      },
      context,
    );
    const zones = Array.from({ length: 51 }, (_, index) => ({ id: `zone-${index + 1}` }));
    const firstPage = { success: true, errors: [], messages: [], result: zones.slice(0, 50) };
    const secondPage = { success: true, errors: [], messages: [], result: zones.slice(50) };
    const merged: unknown[] = [];

    expect(new URL(strategy.next(null, 0).url).searchParams.get("page")).toBe("1");
    strategy.merge(merged, firstPage);
    const secondRequest = strategy.next(firstPage, 1);
    expect(secondRequest.done).toBe(false);
    expect(new URL(secondRequest.url).searchParams.get("page")).toBe("2");
    strategy.merge(merged, secondPage);
    expect(strategy.next(secondPage, 2).done).toBe(true);
    expect(merged).toEqual(zones);
  });

  test("request signature is stable across object key order and covers body config", () => {
    const left = paginationSignature({
      base_url: "https://example.test/report",
      path_or_url: "/report",
      query: { b: 2, a: 1 },
      body: { endDate: "2026-07-28", startDate: "2026-07-01" },
      pagination: { strategy: "offset", parameter_location: "body" },
    });
    const right = paginationSignature({
      base_url: "https://example.test/report",
      path_or_url: "/report",
      query: { a: 1, b: 2 },
      body: { startDate: "2026-07-01", endDate: "2026-07-28" },
      pagination: { parameter_location: "body", strategy: "offset" },
    });
    const changedBody = paginationSignature({
      base_url: "https://example.test/report",
      path_or_url: "/report",
      query: { a: 1, b: 2 },
      body: { startDate: "2026-07-02", endDate: "2026-07-28" },
      pagination: { parameter_location: "body", strategy: "offset" },
    });

    expect(left).toBe(right);
    expect(changedBody).not.toBe(left);
  });
});
