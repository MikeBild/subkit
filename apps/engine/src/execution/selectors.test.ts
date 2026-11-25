import { describe, expect, test } from "bun:test";
import templates from "../connectors/templates.json";
import { makeStrategy } from "./pagination.ts";
import { applySelector, compileSelector, resolveValuePath } from "./selectors.ts";

const SELECTOR_KEYS = new Set(["cursor_response_path", "items_path"]);

const collectSelectorPaths = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) for (const child of node) collectSelectorPaths(child, found);
  else if (node && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      if (SELECTOR_KEYS.has(key) && typeof child === "string") found.push(child);
      else collectSelectorPaths(child, found);
    }
  }
  return found;
};

describe("selectors", () => {
  test("[last] and [first] select the array ends", () => {
    const body = { data: [{ id: "a" }, { id: "b" }] };
    expect(applySelector("$.data[last].id", body)).toBe("b");
    expect(applySelector("$.data[first].id", body)).toBe("a");
    expect(applySelector("$.data[last].id", { data: [] })).toBeUndefined();
  });

  test("cursor pagination with data[last].id requests the next page after the last item", () => {
    const strategy = makeStrategy(
      {
        strategy: "cursor",
        cursor_request_param: "starting_after",
        cursor_response_path: "data[last].id",
        items_path: "data",
      },
      { baseUrl: new URL("https://api.stripe.test/v1/balance_transactions"), baseQuery: {} },
    );
    strategy.next(null, 0);
    const page2 = strategy.next({ data: [{ id: "txn_1" }, { id: "txn_2" }], has_more: true }, 1);
    expect(page2.done).toBe(false);
    expect(new URL(page2.url).searchParams.get("starting_after")).toBe("txn_2");
    expect(strategy.next({ data: [], has_more: false }, 2).done).toBe(true);
    expect(strategy.next({ data: [{ id: "txn_3" }], has_more: false }, 2).done).toBe(true);
  });

  test("every connector template pagination selector compiles", () => {
    const paths = collectSelectorPaths(templates);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(() => compileSelector(path.startsWith("$") ? path : `$.${path}`)).not.toThrow();
    }
  });

  test("resolveValuePath supports dot paths and bracket indices", () => {
    const output = {
      headers: { date: "today", "x-id": "1" },
      body: { data: [{ id: "ch_1" }, { id: "ch_2" }] },
    };
    expect(resolveValuePath(output, "body.data[last].id")).toBe("ch_2");
    expect(resolveValuePath(output, "body.data[0].id")).toBe("ch_1");
    expect(resolveValuePath(output, "headers.date")).toBe("today");
    expect(resolveValuePath(output, "headers.x-id")).toBe("1");
    expect(resolveValuePath(output, "")).toBe(output);
    expect(resolveValuePath(output, "body.missing[last].id")).toBeUndefined();
  });
});
