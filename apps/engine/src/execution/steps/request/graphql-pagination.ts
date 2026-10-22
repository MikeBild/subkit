import type { RequestMeta, RequestPaginationSummary, StepResult } from "../../types.ts";

export interface GraphqlCursorPagination {
  connection_path: string;
  cursor_variable: string;
  items_field: "nodes" | "edges";
  required_connection_paths?: string[] | undefined;
  max_pages: number;
  max_items: number;
  expected_items?: { min?: number | undefined; max?: number | undefined } | undefined;
  reread_on_empty?: number | undefined;
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

type CursorProgress = {
  pages: number;
  items: number;
  limit: RequestPaginationSummary["limit"];
  rereads: number;
};

function cursorSummary(progress: CursorProgress, complete: boolean): RequestPaginationSummary {
  return {
    strategy: "cursor",
    pages: progress.pages,
    items: progress.items,
    duplicates_dropped: 0,
    complete,
    truncated: false,
    limit: progress.limit,
    rereads: progress.rereads,
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

type CursorRead = { result: StepResult; progress: CursorProgress; complete: boolean };

type CursorReadInput = {
  spec: GraphqlCursorPagination;
  variables: Record<string, unknown>;
  execute: (variables: Record<string, unknown>) => Promise<StepResult>;
};

export async function runGraphqlCursorPages(
  p: CursorReadInput & { wait?: (() => Promise<void>) | undefined },
): Promise<StepResult> {
  const started = Date.now();
  const rereadLimit = p.spec.reread_on_empty ?? 0;
  let read = await readCursorPages(p, 0, started);
  while (read.complete && read.progress.items === 0 && read.progress.rereads < rereadLimit) {
    await p.wait?.();
    read = await readCursorPages(p, read.progress.rereads + 1, started);
  }
  if (!read.complete) return read.result;
  const { min, max } = p.spec.expected_items ?? {};
  const count = read.progress.items;
  const outOfRange =
    min !== undefined && count < min
      ? `The complete read returned ${count} items, fewer than the expected minimum ${min}${read.progress.rereads > 0 ? ` after ${read.progress.rereads + 1} reads` : ""}.`
      : max !== undefined && count > max
        ? `The complete read returned ${count} items, more than the expected maximum ${max}.`
        : null;
  return outOfRange ? incomplete(outOfRange, read.result, started, read.progress) : read.result;
}

async function readCursorPages(
  p: CursorReadInput,
  rereads: number,
  started: number,
): Promise<CursorRead> {
  const failed = (result: StepResult, progress: CursorProgress): CursorRead => ({
    result,
    progress,
    complete: false,
  });
  const { spec } = p;
  if (
    p.variables[spec.cursor_variable] !== undefined &&
    p.variables[spec.cursor_variable] !== null
  ) {
    const progress = { pages: 0, items: 0, limit: null, rereads };
    return failed(
      incomplete("Start the complete read without an initial cursor.", null, started, progress),
      progress,
    );
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
    rereads,
  });
  const stop = (reason: string, limit: CursorProgress["limit"] = null): CursorRead =>
    failed(incomplete(reason, last, started, progress(limit)), progress(limit));
  for (let page = 1; page <= spec.max_pages; page++) {
    const variables = { ...p.variables, [spec.cursor_variable]: cursor };
    last = await p.execute(variables);
    if (last.status !== "succeeded")
      return failed(withSummary(last, progress(), false), progress());
    pagesRead = page;
    if (last.warnings?.some((warning) => warning.code === "graphql_partial_errors")) {
      return stop("The GraphQL page contained partial errors; repeat after repairing the query.");
    }
    const connection = connectionAt(last.output, spec.connection_path);
    const pageItems = connection?.[spec.items_field];
    const info = connection?.pageInfo;
    if (!connection || !Array.isArray(pageItems) || !info || typeof info !== "object") {
      return stop("The response lacks the configured connection, items or pageInfo.");
    }
    const pageInfo = info as Record<string, unknown>;
    const firstTotal = firstConnection?.totalCount;
    if (
      page > 1 &&
      typeof firstTotal === "number" &&
      typeof connection.totalCount === "number" &&
      connection.totalCount !== firstTotal
    ) {
      return stop("A later page reports a different totalCount; repeat the read.");
    }
    if (typeof pageInfo.hasNextPage !== "boolean") {
      return stop("The response lacks pageInfo.hasNextPage.");
    }
    if (pageItems.some((item) => item === null)) {
      return stop("The connection contains a null item; completeness cannot be verified.");
    }
    if (spec.items_field === "edges" && pageItems.some((item) => nodeOf(item, "edges") == null)) {
      return stop("The connection contains an edge without a node.");
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
          return stop(`The response lacks the required nested connection ${path} or its pageInfo.`);
        }
        if ((nestedPageInfo as Record<string, unknown>).hasNextPage) {
          return stop(
            `The nested connection ${path} has more pages; read it separately or increase its page size.`,
          );
        }
        if (typeof nested.totalCount === "number" && nested.totalCount !== nestedItems.length) {
          return stop(`The nested connection ${path} item count differs from totalCount.`);
        }
      }
    }
    bytes += Buffer.byteLength(JSON.stringify(pageItems));
    if (items.length + pageItems.length > spec.max_items || bytes > MAX_ACCUMULATED_BYTES) {
      return stop(
        "The configured item or memory limit was reached before completion.",
        items.length + pageItems.length > spec.max_items ? "max_items" : "max_bytes",
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
        return stop("Retrieved item count differs from totalCount; repeat the read.");
      }
      const ids = items.map((item) => idOf(item, spec.items_field));
      if (ids.every((id) => typeof id === "string") && new Set(ids).size !== ids.length) {
        return stop("Duplicate item IDs prevent a complete snapshot.");
      }
      if (!firstConnection) return stop("The first page is unavailable.");
      firstConnection[spec.items_field] = items;
      firstConnection.pageInfo = pageInfo;
      return {
        result: withSummary(
          { ...last, output: firstOutput, duration_ms: Date.now() - started },
          progress(),
          true,
        ),
        progress: progress(),
        complete: true,
      };
    }
    const next = pageInfo.endCursor;
    if (typeof next !== "string" || next.length === 0 || seenCursors.has(next)) {
      return stop("The next cursor is missing or repeated.");
    }
    seenCursors.add(next);
    cursor = next;
  }
  return stop("The page limit was reached while hasNextPage remained true.", "max_pages");
}
