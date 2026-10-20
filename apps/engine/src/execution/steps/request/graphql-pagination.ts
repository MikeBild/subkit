import type { StepResult } from "../../types.ts";

export interface GraphqlCursorPagination {
  connection_path: string;
  cursor_variable: string;
  items_field: "nodes" | "edges";
  max_pages: number;
  max_items: number;
}

const MAX_ACCUMULATED_BYTES = 4 * 1024 * 1024;

function connectionAt(output: unknown, path: string): Record<string, unknown> | null {
  let current = output;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== null && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
}

function incomplete(reason: string, last: StepResult | null, started: number): StepResult {
  return {
    status: "failed",
    retry_count: last?.retry_count ?? 0,
    duration_ms: Date.now() - started,
    error: { code: "graphql_pagination_incomplete", message: reason },
    ...(last?.request_meta ? { request_meta: last.request_meta } : {}),
  };
}

export async function runGraphqlCursorPages(p: {
  spec: GraphqlCursorPagination;
  variables: Record<string, unknown>;
  execute: (variables: Record<string, unknown>) => Promise<StepResult>;
}): Promise<StepResult> {
  const started = Date.now();
  const { spec } = p;
  if (
    p.variables[spec.cursor_variable] !== undefined &&
    p.variables[spec.cursor_variable] !== null
  ) {
    return incomplete("Start the complete read without an initial cursor.", null, started);
  }
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let firstOutput: unknown = null;
  let firstConnection: Record<string, unknown> | null = null;
  let last: StepResult | null = null;
  let bytes = 0;
  for (let page = 1; page <= spec.max_pages; page++) {
    const variables = { ...p.variables, [spec.cursor_variable]: cursor };
    last = await p.execute(variables);
    if (last.status !== "succeeded") return last;
    if (last.warnings?.some((warning) => warning.code === "graphql_partial_errors")) {
      return incomplete(
        "The GraphQL page contained partial errors; repeat after repairing the query.",
        last,
        started,
      );
    }
    const connection = connectionAt(last.output, spec.connection_path);
    const pageItems = connection?.[spec.items_field];
    const info = connection?.pageInfo;
    if (!connection || !Array.isArray(pageItems) || !info || typeof info !== "object") {
      return incomplete(
        "The response lacks the configured connection, items or pageInfo.",
        last,
        started,
      );
    }
    const pageInfo = info as Record<string, unknown>;
    if (typeof pageInfo.hasNextPage !== "boolean") {
      return incomplete("The response lacks pageInfo.hasNextPage.", last, started);
    }
    if (pageItems.some((item) => item === null)) {
      return incomplete(
        "The connection contains a null item; completeness cannot be verified.",
        last,
        started,
      );
    }
    bytes += Buffer.byteLength(JSON.stringify(pageItems));
    if (items.length + pageItems.length > spec.max_items || bytes > MAX_ACCUMULATED_BYTES) {
      return incomplete(
        "The configured item or memory limit was reached before completion.",
        last,
        started,
      );
    }
    items.push(...pageItems);
    if (page === 1) {
      firstOutput = last.output;
      firstConnection = connection;
    }
    if (!pageInfo.hasNextPage) {
      const total = firstConnection?.totalCount;
      if (typeof total === "number" && total !== items.length) {
        return incomplete(
          "Retrieved item count differs from totalCount; repeat the read.",
          last,
          started,
        );
      }
      const ids = items.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>).id
          : undefined,
      );
      if (ids.every((id) => typeof id === "string") && new Set(ids).size !== ids.length) {
        return incomplete("Duplicate item IDs prevent a complete snapshot.", last, started);
      }
      if (!firstConnection) return incomplete("The first page is unavailable.", last, started);
      firstConnection[spec.items_field] = items;
      firstConnection.pageInfo = pageInfo;
      return { ...last, output: firstOutput, duration_ms: Date.now() - started };
    }
    const next = pageInfo.endCursor;
    if (typeof next !== "string" || next.length === 0 || seenCursors.has(next)) {
      return incomplete("The next cursor is missing or repeated.", last, started);
    }
    seenCursors.add(next);
    cursor = next;
  }
  return incomplete("The page limit was reached while hasNextPage remained true.", last, started);
}
