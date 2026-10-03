import { type QueryKey, useInfiniteQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";

// An endless list over a cursor-paged engine endpoint: `?cursor=` in, the
// page's `items` and `next_cursor` out (null on the last page). Pages are
// flattened into one row list for `DataTable`'s `infinite` prop.

export interface CursorPage<T> {
  items: T[];
  next_cursor?: string | null;
  total?: number;
}

export type ListParams = Record<string, string | number | boolean | null | undefined>;

/**
 * The query-key family each list lives under — the same names the live
 * invalidation table refreshes, so a new run or audit entry reaches an open
 * endless list without a key of its own.
 */
const LIST_KEYS: Record<string, string> = {
  "/v1/executions": "runs",
  "/v1/audit-log": "audit",
};

export function listQueryKey(path: string, params: ListParams): QueryKey {
  return [LIST_KEYS[path] ?? path, "infinite", path, params];
}

/** The request for one page: the filters, the page size and the cursor. */
export function listPagePath(
  path: string,
  params: ListParams,
  limit: number,
  cursor: string | null,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  search.set("limit", String(limit));
  if (cursor) search.set("cursor", cursor);
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
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiRequest<CursorPage<T>>(listPagePath(path, params, limit, pageParam), { signal }),
    getNextPageParam: (last) => last.next_cursor ?? null,
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
