// Pagination loop helpers. The request step driver hands each page-fetch
// call back to a strategy object that decides:
//   - the URL/query for the next page
//   - whether to stop (empty page, page count cap, missing cursor)
// All three strategies cap at 1,000 requests per step.

import { applySelector } from "./selectors.ts";

export const MAX_PAGES = 1000;
export const PAGE_PROGRESS_INTERVAL = 50;

export interface PageContext {
  baseUrl: URL;
  baseQuery: Record<string, string>;
}

export interface NextPage {
  url: string;
  done: boolean;
}

export interface PaginationStrategyState {
  next(prevResponse: unknown, pageIdx: number): NextPage;
  merge(acc: unknown[], pageBody: unknown): unknown[];
}

function buildUrl(base: URL, query: Record<string, string>): string {
  const u = new URL(base.toString());
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

interface OffsetSpec {
  strategy: "offset";
  page_size: number;
  offset_param: string;
  limit_param: string;
  stop_when_empty_path?: string;
}

interface PageSpec {
  strategy: "page";
  page_size: number;
  page_param: string;
  limit_param: string;
  start_page: number;
}

interface CursorSpec {
  strategy: "cursor";
  cursor_request_param: string;
  cursor_response_path: string;
  page_size?: number;
  limit_param?: string;
}

export type PaginationSpec = OffsetSpec | PageSpec | CursorSpec;

export function makeStrategy(spec: PaginationSpec, ctx: PageContext): PaginationStrategyState {
  if (spec.strategy === "offset") {
    let offset = 0;
    return {
      next(prev, idx) {
        if (idx === 0) {
          offset = 0;
          return {
            url: buildUrl(ctx.baseUrl, {
              ...ctx.baseQuery,
              [spec.offset_param]: String(offset),
              [spec.limit_param]: String(spec.page_size),
            }),
            done: false,
          };
        }
        // Stop when the previous response was empty / shorter than page size.
        const arr = extractArray(prev, spec.stop_when_empty_path);
        if (!arr || arr.length === 0 || arr.length < spec.page_size) {
          return { url: "", done: true };
        }
        offset += spec.page_size;
        return {
          url: buildUrl(ctx.baseUrl, {
            ...ctx.baseQuery,
            [spec.offset_param]: String(offset),
            [spec.limit_param]: String(spec.page_size),
          }),
          done: false,
        };
      },
      merge(acc, body) {
        const arr = extractArray(body, spec.stop_when_empty_path);
        if (Array.isArray(arr)) acc.push(...arr);
        else acc.push(body);
        return acc;
      },
    };
  }
  if (spec.strategy === "page") {
    let page = spec.start_page;
    return {
      next(prev, idx) {
        if (idx === 0) {
          page = spec.start_page;
          return {
            url: buildUrl(ctx.baseUrl, {
              ...ctx.baseQuery,
              [spec.page_param]: String(page),
              [spec.limit_param]: String(spec.page_size),
            }),
            done: false,
          };
        }
        const arr = extractArray(prev);
        if (!arr || arr.length === 0 || arr.length < spec.page_size) {
          return { url: "", done: true };
        }
        page += 1;
        return {
          url: buildUrl(ctx.baseUrl, {
            ...ctx.baseQuery,
            [spec.page_param]: String(page),
            [spec.limit_param]: String(spec.page_size),
          }),
          done: false,
        };
      },
      merge(acc, body) {
        const arr = extractArray(body);
        if (Array.isArray(arr)) acc.push(...arr);
        else acc.push(body);
        return acc;
      },
    };
  }
  // cursor
  let cursor: string | null = null;
  return {
    next(prev, idx) {
      if (idx === 0) {
        const params: Record<string, string> = { ...ctx.baseQuery };
        if (spec.limit_param && spec.page_size != null)
          params[spec.limit_param] = String(spec.page_size);
        return { url: buildUrl(ctx.baseUrl, params), done: false };
      }
      const next = applySelector(spec.cursor_response_path, prev);
      if (next == null || next === "" || (Array.isArray(next) && next.length === 0)) {
        return { url: "", done: true };
      }
      cursor = String(Array.isArray(next) ? next[0] : next);
      const params: Record<string, string> = {
        ...ctx.baseQuery,
        [spec.cursor_request_param]: cursor,
      };
      if (spec.limit_param && spec.page_size != null)
        params[spec.limit_param] = String(spec.page_size);
      return { url: buildUrl(ctx.baseUrl, params), done: false };
    },
    merge(acc, body) {
      const arr = extractArray(body);
      if (Array.isArray(arr)) acc.push(...arr);
      else acc.push(body);
      return acc;
    },
  };
}

function extractArray(body: unknown, path?: string): unknown[] | null {
  if (body == null) return null;
  if (Array.isArray(body)) return body;
  if (path) {
    try {
      const v = applySelector(path, body);
      if (Array.isArray(v)) return v;
      if (v == null) return null;
      return [v];
    } catch {
      return null;
    }
  }
  // Heuristic: pick the first array property.
  if (typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}
