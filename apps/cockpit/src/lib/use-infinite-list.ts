import { type QueryKey, useInfiniteQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";

export interface CursorPage<T> {
  items: T[];
  next_cursor?: string | null;
  total?: number;
}

export type ListParams = Record<string, string | number | boolean | null | undefined>;

export type PageParam = string | number | null;

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

export function nextPageParam<T>(pages: readonly CursorPage<T>[]): PageParam {
  const last = pages[pages.length - 1];
  if (!last) return null;
  if (typeof last.next_cursor === "string" && last.next_cursor) return last.next_cursor;
  if (typeof last.total !== "number") return null;
  const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
  return loaded < last.total && last.items.length > 0 ? loaded : null;
}

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

export function uniqueById<T>(items: readonly T[]): T[] {
  const seen = new Set<unknown>();
  return items.filter((item) => {
    const id = (item as { id?: unknown } | null)?.id;
    if (id === undefined || id === null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function useInfiniteList<T, P extends CursorPage<T> = CursorPage<T>>(
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
      apiRequest<P>(listPagePath(path, params, limit, pageParam), { signal }),
    getNextPageParam: (_last, pages) => nextPageParam(pages),
  });
  const pages = query.data?.pages ?? [];
  return {
    query,
    items: uniqueById(pages.flatMap((page) => page.items)),
    total: pages[0]?.total,
    first: pages[0],
    infinite: {
      fetchNextPage: query.fetchNextPage,
      hasNextPage: query.hasNextPage,
      isFetchingNextPage: query.isFetchingNextPage,
    },
  };
}
