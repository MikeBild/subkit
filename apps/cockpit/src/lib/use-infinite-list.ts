import { type QueryKey, useInfiniteQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";

// An endless list over a paged engine endpoint. A cursor-paged list answers
// with `next_cursor` (null on the last page) and is asked again with
// `?cursor=`; a list paged by offset answers with `total` and is asked again
// with `?offset=` until every row is loaded. Pages are flattened into one row
// list for `DataTable`'s `infinite` prop.

export interface CursorPage<T> {
  items: T[];
  next_cursor?: string | null;
  total?: number;
}

export type ListParams = Record<string, string | number | boolean | null | undefined>;

/** Where the next page starts: a cursor, an offset, or nowhere (the end). */
export type PageParam = string | number | null;

/**
 * The query-key family each list lives under — the names the live
 * invalidation table refreshes, so a new run reaches an open endless list
 * without a key of its own. (Nothing refreshes the audit log live: it has no
 * outbox event; its key only groups its pages.)
 */
const LIST_KEYS: Record<string, string> = {
  "/v1/executions": "runs",
  "/v1/audit-log": "audit",
  "/v1/workflows": "catalog",
  "/v1/connectors": "catalog",
  "/v1/knowledge-sources": "catalog",
  "/v1/skills": "catalog",
  "/v1/files": "catalog",
};

export function listQueryKey(path: string, params: ListParams): QueryKey {
  return [LIST_KEYS[path] ?? path, "infinite", path, params];
}

/** The next page after `pages`, by the paging the endpoint answered with. */
export function nextPageParam<T>(pages: readonly CursorPage<T>[]): PageParam {
  const last = pages[pages.length - 1];
  if (!last) return null;
  if ("next_cursor" in last) return last.next_cursor ?? null;
  if (typeof last.total !== "number") return null;
  const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
  return loaded < last.total && last.items.length > 0 ? loaded : null;
}

/** The request for one page: the filters, the page size and where it starts. */
export function listPagePath(
  path: string,
  params: ListParams,
  limit: number,
  start: PageParam,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  search.set("limit", String(limit));
  if (typeof start === "number") search.set("offset", String(start));
  else if (start) search.set("cursor", start);
  return `${path}?${search}`;
}

export function useInfiniteList<T>(
  path: string,
  params: ListParams = {},
  options: { limit?: number; enabled?: boolean; queryKey?: QueryKey } = {},
) {
  const limit = options.limit ?? 50;
  const query = useInfiniteQuery({
    queryKey: options.queryKey ?? listQueryKey(path, params),
    enabled: options.enabled ?? true,
    initialPageParam: null as PageParam,
    queryFn: ({ pageParam, signal }) =>
      apiRequest<CursorPage<T>>(listPagePath(path, params, limit, pageParam), { signal }),
    getNextPageParam: (_last, pages) => nextPageParam(pages),
  });
  const pages = query.data?.pages ?? [];
  return {
    query,
    items: pages.flatMap((page) => page.items),
    total: pages[0]?.total,
    /** Hand to `DataTable`'s `infinite` prop. */
    infinite: {
      fetchNextPage: query.fetchNextPage,
      hasNextPage: query.hasNextPage,
      isFetchingNextPage: query.isFetchingNextPage,
    },
  };
}
