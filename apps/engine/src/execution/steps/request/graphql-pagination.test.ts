import { expect, test } from "bun:test";
import { runGraphqlCursorPages } from "./graphql-pagination.ts";

const spec = {
  connection_path: "user.project.items",
  cursor_variable: "after",
  items_field: "nodes" as const,
  max_pages: 4,
  max_items: 63,
};

test("merges every cursor page and verifies the declared total", async () => {
  const counts = [20, 20, 20, 3];
  const cursors: unknown[] = [];
  const result = await runGraphqlCursorPages({
    spec,
    variables: { first: 20 },
    execute: async (variables) => {
      cursors.push(variables.after);
      const page = cursors.length - 1;
      const start = counts.slice(0, page).reduce((sum, count) => sum + count, 0);
      return {
        status: "succeeded",
        retry_count: 0,
        duration_ms: 0,
        output: {
          user: {
            project: {
              items: {
                totalCount: 63,
                nodes: Array.from({ length: counts[page]! }, (_, index) => ({
                  id: `${start + index}`,
                })),
                pageInfo: { hasNextPage: page < 3, endCursor: page < 3 ? `cursor-${page}` : null },
              },
            },
          },
        },
      };
    },
  });
  expect(result.status).toBe("succeeded");
  expect(cursors).toEqual([null, "cursor-0", "cursor-1", "cursor-2"]);
  const output = result.output as { user: { project: { items: { nodes: unknown[] } } } };
  expect(output.user.project.items.nodes).toHaveLength(63);
});

test("fails when the page bound ends before the connection", async () => {
  const result = await runGraphqlCursorPages({
    spec: { ...spec, max_pages: 1 },
    variables: {},
    execute: async () => ({
      status: "succeeded",
      retry_count: 0,
      duration_ms: 0,
      output: {
        user: {
          project: {
            items: {
              totalCount: 2,
              nodes: [{ id: "one" }],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            },
          },
        },
      },
    }),
  });
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "graphql_pagination_incomplete" },
  });
  expect(result.output).toBeUndefined();
});

test("fails on missing cursor, duplicate IDs and incomplete count", async () => {
  for (const items of [
    { nodes: [{ id: "one" }], totalCount: 2, pageInfo: { hasNextPage: false } },
    { nodes: [{ id: "one" }, { id: "one" }], totalCount: 2, pageInfo: { hasNextPage: false } },
    { nodes: [{ id: "one" }], totalCount: 2, pageInfo: { hasNextPage: true } },
  ]) {
    const result = await runGraphqlCursorPages({
      spec,
      variables: {},
      execute: async () => ({
        status: "succeeded",
        retry_count: 0,
        duration_ms: 0,
        output: { user: { project: { items } } },
      }),
    });
    expect(result.error?.code).toBe("graphql_pagination_incomplete");
  }
});

test("rejects a GraphQL partial page without returning its data", async () => {
  const result = await runGraphqlCursorPages({
    spec,
    variables: {},
    execute: async () => ({
      status: "succeeded",
      retry_count: 0,
      duration_ms: 0,
      output: {
        user: {
          project: {
            items: {
              totalCount: 1,
              nodes: [{ id: "partial" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      warnings: [{ code: "graphql_partial_errors", message: "A field failed" }],
    }),
  });
  expect(result.error?.code).toBe("graphql_pagination_incomplete");
  expect(result.output).toBeUndefined();
});
