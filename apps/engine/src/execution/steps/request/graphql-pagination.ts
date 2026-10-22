import type { RequestMeta, RequestPaginationSummary, StepResult } from "../../types.ts";

export interface GraphqlCursorPagination {
  connection_path: string;
  cursor_variable: string;
  items_field: "nodes" | "edges";
  required_connection_paths?: string[] | undefined;
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

type CursorProgress = { pages: number; items: number; limit: RequestPaginationSummary["limit"] };

function cursorSummary(progress: CursorProgress, complete: boolean): RequestPaginationSummary {
  return {
    strategy: "cursor",
    pages: progress.pages,
    items: progress.items,
    duplicates_dropped: 0,
    complete,
    truncated: false,
    limit: progress.limit,
  };
}

function withSummary(result: StepResult, progress: CursorProgress, complete: boolean): StepResult {
  if (!result.request_meta) return result;
  return {
    ...result,
    request_meta: {
      ...result.request_meta,
      pagination: cursorSummary(progress, complete),
    } as RequestMeta,
  };
}

function incomplete(
  reason: string,
  last: StepResult | null,
  started: number,
  progress: CursorProgress,
): StepResult {
  return withSummary(
    {
      status: "failed",
      retry_count: last?.retry_count ?? 0,
      duration_ms: Date.now() - started,
      error: { code: "graphql_pagination_incomplete", message: reason },
      ...(last?.request_meta ? { request_meta: last.request_meta } : {}),
    },
    progress,
    false,
  );
}

function nodeOf(item: unknown, itemsField: GraphqlCursorPagination["items_field"]): unknown {
  if (itemsField === "nodes") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  return (item as Record<string, unknown>).node;
}

function idOf(item: unknown, itemsField: GraphqlCursorPagination["items_field"]): unknown {
  const node = nodeOf(item, itemsField);
  return node && typeof node === "object" && !Array.isArray(node)
    ? (node as Record<string, unknown>).id
    : undefined;
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
    return incomplete("Start the complete read without an initial cursor.", null, started, {
      pages: 0,
      items: 0,
      limit: null,
    });
  }
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let firstOutput: unknown = null;
  let firstConnection: Record<string, unknown> | null = null;
  let last: StepResult | null = null;
  let bytes = 0;
  let pagesRead = 0;
  const progress = (limit: CursorProgress["limit"] = null): CursorProgress => ({
    pages: pagesRead,
    items: items.length,
    limit,
  });
  for (let page = 1; page <= spec.max_pages; page++) {
    const variables = { ...p.variables, [spec.cursor_variable]: cursor };
    last = await p.execute(variables);
    if (last.status !== "succeeded") return withSummary(last, progress(), false);
    pagesRead = page;
    if (last.warnings?.some((warning) => warning.code === "graphql_partial_errors")) {
      return incomplete(
        "The GraphQL page contained partial errors; repeat after repairing the query.",
        last,
        started,
        progress(),
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
        progress(),
      );
    }
    const pageInfo = info as Record<string, unknown>;
    if (typeof pageInfo.hasNextPage !== "boolean") {
      return incomplete("The response lacks pageInfo.hasNextPage.", last, started, progress());
    }
    if (pageItems.some((item) => item === null)) {
      return incomplete(
        "The connection contains a null item; completeness cannot be verified.",
        last,
        started,
        progress(),
      );
    }
    if (spec.items_field === "edges" && pageItems.some((item) => nodeOf(item, "edges") == null)) {
      return incomplete(
        "The connection contains an edge without a node.",
        last,
        started,
        progress(),
      );
    }
    for (const item of pageItems) {
      const node = nodeOf(item, spec.items_field);
      for (const path of spec.required_connection_paths ?? []) {
        const nested = connectionAt(node, path);
        const nestedPageInfo = nested?.pageInfo;
        const nestedItems = nested?.nodes ?? nested?.edges;
        if (
          !nested ||
          !Array.isArray(nestedItems) ||
          !nestedPageInfo ||
          typeof nestedPageInfo !== "object" ||
          typeof (nestedPageInfo as Record<string, unknown>).hasNextPage !== "boolean"
        ) {
          return incomplete(
            `The response lacks the required nested connection ${path} or its pageInfo.`,
            last,
            started,
            progress(),
          );
        }
        if ((nestedPageInfo as Record<string, unknown>).hasNextPage) {
          return incomplete(
            `The nested connection ${path} has more pages; read it separately or increase its page size.`,
            last,
            started,
            progress(),
          );
        }
        if (typeof nested.totalCount === "number" && nested.totalCount !== nestedItems.length) {
          return incomplete(
            `The nested connection ${path} item count differs from totalCount.`,
            last,
            started,
            progress(),
          );
        }
      }
    }
    bytes += Buffer.byteLength(JSON.stringify(pageItems));
    if (items.length + pageItems.length > spec.max_items || bytes > MAX_ACCUMULATED_BYTES) {
      return incomplete(
        "The configured item or memory limit was reached before completion.",
        last,
        started,
        progress(items.length + pageItems.length > spec.max_items ? "max_items" : "max_bytes"),
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
          progress(),
        );
      }
      const ids = items.map((item) => idOf(item, spec.items_field));
      if (ids.every((id) => typeof id === "string") && new Set(ids).size !== ids.length) {
        return incomplete(
          "Duplicate item IDs prevent a complete snapshot.",
          last,
          started,
          progress(),
        );
      }
      if (!firstConnection)
        return incomplete("The first page is unavailable.", last, started, progress());
      firstConnection[spec.items_field] = items;
      firstConnection.pageInfo = pageInfo;
      return withSummary(
        { ...last, output: firstOutput, duration_ms: Date.now() - started },
        progress(),
        true,
      );
    }
    const next = pageInfo.endCursor;
    if (typeof next !== "string" || next.length === 0 || seenCursors.has(next)) {
      return incomplete("The next cursor is missing or repeated.", last, started, progress());
    }
    seenCursors.add(next);
    cursor = next;
  }
  return incomplete(
    "The page limit was reached while hasNextPage remained true.",
    last,
    started,
    progress("max_pages"),
  );
}
