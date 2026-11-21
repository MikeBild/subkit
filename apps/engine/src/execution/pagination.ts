import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseLinkHeader } from "../connectors/health.ts";
import type { Db } from "../db/client.ts";
import { executionSteps } from "../db/schema/index.ts";
import { envInt } from "../env.ts";
import { applySelector } from "./selectors.ts";

export const MAX_PAGES = 1000;
export const PAGE_PROGRESS_INTERVAL = 50;

export const PAGINATION_CHECKPOINT_INTERVAL: number = envInt("PAGINATION_CHECKPOINT_INTERVAL", 50);

interface PageContext {
  baseUrl: URL;
  baseQuery: Record<string, string>;
}

interface NextPage {
  url: string;
  done: boolean;
  body_parameters?: Record<string, string | number>;
}

type PaginationErrorCode =
  | "pagination_link_foreign"
  | "pagination_link_unsupported"
  | "pagination_link_loop"
  | "pagination_short_page";

export class PaginationError extends Error {
  constructor(
    message: string,
    public readonly code: PaginationErrorCode,
  ) {
    super(message);
    this.name = "PaginationError";
  }
}

interface PaginationStrategyState {
  next(prevResponse: unknown, pageIdx: number, prevHeaders?: Record<string, string>): NextPage;
  merge(acc: unknown[], pageBody: unknown): unknown[];
  snapshot(lastBody: unknown): PaginationCheckpointState;
}

export type PaginationCheckpointState =
  | { kind: "offset"; offset: number }
  | { kind: "page"; page: number }
  | { kind: "cursor"; cursor: string | null }
  | { kind: "link"; params: Record<string, string> };

export interface PaginationCheckpoint {
  state: PaginationCheckpointState;
  page_idx: number;
  accumulated_count: number;
  signature: string;
  written_at: string;
}

export function paginationSignature(input: {
  base_url: string;
  path_or_url: string;
  query: Record<string, unknown>;
  body?: unknown;
  pagination?: unknown;
}): string {
  const payload = JSON.stringify(
    sortJsonValue({
      base_url: input.base_url,
      path_or_url: input.path_or_url,
      query: input.query,
      body: input.body ?? null,
      pagination: input.pagination ?? null,
    }),
  );
  return createHash("sha256").update(payload).digest("hex");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
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
  parameter_location?: "query" | "body";
  output_mode?: "items" | "pages";
  items_path?: string;
  stop_when_empty_path?: string;
  max_pages?: number;
}

interface PageSpec {
  strategy: "page";
  page_size: number;
  page_param: string;
  limit_param: string;
  start_page: number;
  parameter_location?: "query" | "body";
  output_mode?: "items" | "pages";
  items_path?: string;
  max_pages?: number;
}

interface CursorSpec {
  strategy: "cursor";
  cursor_request_param: string;
  cursor_response_path: string;
  page_size?: number;
  limit_param?: string;
  parameter_location?: "query" | "body";
  output_mode?: "items" | "pages";
  items_path?: string;
  max_pages?: number;
}

interface LinkSpec {
  strategy: "link";
  link_params: string[];
  page_size?: number;
  limit_param?: string;
  output_mode?: "items" | "pages";
  items_path?: string;
  max_pages?: number;
}

export type PaginationSpec = OffsetSpec | PageSpec | CursorSpec | LinkSpec;

const LINK_VALUE = /^[A-Za-z0-9+/=_.:~-]{1,512}$/;

function hasNextLink(headers?: Record<string, string>): boolean {
  return parseLinkHeader(headers?.link).some((relation) => relation.rels.includes("next"));
}

function shortPageWithNext(
  arr: unknown[] | null,
  pageSize: number,
  headers?: Record<string, string>,
): void {
  if (arr && arr.length > 0 && arr.length < pageSize && hasNextLink(headers))
    throw new PaginationError(
      "pagination received a short page while the response announced a next page; the server likely capped the page size, lower page_size to the vendor maximum",
      "pagination_short_page",
    );
}

function mergeItems(
  spec: { output_mode?: "items" | "pages"; items_path?: string },
  acc: unknown[],
  body: unknown,
  fallbackPath?: string,
): unknown[] {
  if (spec.output_mode === "pages") {
    acc.push(body);
    return acc;
  }
  const arr = extractArray(body, spec.items_path ?? fallbackPath);
  if (Array.isArray(arr)) acc.push(...arr);
  else acc.push(body);
  return acc;
}

function makeLinkStrategy(spec: LinkSpec, ctx: PageContext): PaginationStrategyState {
  const authored = new URL(ctx.baseUrl.toString());
  for (const [key, value] of Object.entries(ctx.baseQuery)) authored.searchParams.set(key, value);
  const linkParams = new Set(spec.link_params);
  const pageSize = spec.limit_param && spec.page_size != null ? String(spec.page_size) : null;
  const seen = new Set<string>();
  let current: Record<string, string> = {};
  const build = (params: Record<string, string>): string => {
    const url = new URL(authored.toString());
    for (const name of linkParams) url.searchParams.delete(name);
    if (spec.limit_param && pageSize) url.searchParams.set(spec.limit_param, pageSize);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  };
  const tupleOf = (params: Record<string, string>) =>
    JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    next(_prev, idx, headers) {
      if (idx === 0) {
        current = {};
        seen.clear();
        seen.add(tupleOf(current));
        return { url: build(current), done: false };
      }
      const relation = parseLinkHeader(headers?.link).find((entry) => entry.rels.includes("next"));
      if (!relation) return { url: "", done: true };
      let target: URL;
      try {
        target = new URL(relation.url, authored);
      } catch {
        throw new PaginationError(
          "pagination next link is not a valid URL",
          "pagination_link_unsupported",
        );
      }
      if (target.origin !== authored.origin)
        throw new PaginationError(
          "pagination next link points to a different origin than the step; nothing was sent there",
          "pagination_link_foreign",
        );
      const keys = [...target.searchParams.keys()];
      if (new Set(keys).size !== keys.length)
        throw new PaginationError(
          "pagination next link repeats a query parameter",
          "pagination_link_unsupported",
        );
      const params: Record<string, string> = {};
      for (const [key, value] of target.searchParams) {
        if (linkParams.has(key)) {
          if (!LINK_VALUE.test(value))
            throw new PaginationError(
              `pagination next link carries an unsupported value for ${key}`,
              "pagination_link_unsupported",
            );
          params[key] = value;
        } else if (spec.limit_param && key === spec.limit_param) {
          if (pageSize !== null && value !== pageSize)
            throw new PaginationError(
              `pagination next link changed ${key} from ${pageSize} to a different page size; lower page_size to the vendor maximum`,
              "pagination_short_page",
            );
        } else if (authored.searchParams.has(key)) {
          if (authored.searchParams.get(key) !== value)
            throw new PaginationError(
              `pagination next link changed the authored query parameter ${key}`,
              "pagination_link_unsupported",
            );
        } else {
          throw new PaginationError(
            `pagination next link carries the query parameter ${key}, which is neither authored nor listed in link_params`,
            "pagination_link_unsupported",
          );
        }
      }
      const tuple = tupleOf(params);
      if (seen.has(tuple))
        throw new PaginationError(
          "pagination next link repeats an earlier page",
          "pagination_link_loop",
        );
      seen.add(tuple);
      current = params;
      return { url: build(params), done: false };
    },
    merge(acc, body) {
      return mergeItems(spec, acc, body);
    },
    snapshot() {
      return { kind: "link", params: { ...current } };
    },
  };
}

export function makeStrategy(spec: PaginationSpec, ctx: PageContext): PaginationStrategyState {
  if (spec.strategy === "link") return makeLinkStrategy(spec, ctx);
  if (spec.strategy === "offset") {
    let offset = 0;
    return {
      next(prev, idx, headers) {
        if (idx === 0) {
          offset = 0;
          return buildNextPage(spec, ctx, {
            [spec.offset_param]: offset,
            [spec.limit_param]: spec.page_size,
          });
        }
        const arr = extractArray(prev, spec.items_path ?? spec.stop_when_empty_path);
        shortPageWithNext(arr, spec.page_size, headers);
        if (!arr || arr.length === 0 || arr.length < spec.page_size) {
          return { url: "", done: true };
        }
        offset += spec.page_size;
        return buildNextPage(spec, ctx, {
          [spec.offset_param]: offset,
          [spec.limit_param]: spec.page_size,
        });
      },
      merge(acc, body) {
        if (spec.output_mode === "pages") {
          acc.push(body);
          return acc;
        }
        const arr = extractArray(body, spec.items_path ?? spec.stop_when_empty_path);
        if (Array.isArray(arr)) acc.push(...arr);
        else acc.push(body);
        return acc;
      },
      snapshot(_lastBody) {
        return { kind: "offset", offset };
      },
    };
  }
  if (spec.strategy === "page") {
    let page = spec.start_page;
    return {
      next(prev, idx, headers) {
        if (idx === 0) {
          page = spec.start_page;
          return buildNextPage(spec, ctx, {
            [spec.page_param]: page,
            [spec.limit_param]: spec.page_size,
          });
        }
        const arr = extractArray(prev, spec.items_path);
        shortPageWithNext(arr, spec.page_size, headers);
        if (!arr || arr.length === 0 || arr.length < spec.page_size) {
          return { url: "", done: true };
        }
        page += 1;
        return buildNextPage(spec, ctx, {
          [spec.page_param]: page,
          [spec.limit_param]: spec.page_size,
        });
      },
      merge(acc, body) {
        if (spec.output_mode === "pages") {
          acc.push(body);
          return acc;
        }
        const arr = extractArray(body, spec.items_path);
        if (Array.isArray(arr)) acc.push(...arr);
        else acc.push(body);
        return acc;
      },
      snapshot(_lastBody) {
        return { kind: "page", page };
      },
    };
  }
  let cursor: string | null = null;
  return {
    next(prev, idx) {
      if (idx === 0) {
        const params: Record<string, string | number> = {};
        if (cursor !== null) params[spec.cursor_request_param] = cursor;
        if (spec.limit_param && spec.page_size != null) params[spec.limit_param] = spec.page_size;
        return buildNextPage(spec, ctx, params);
      }
      const next = applyPaginationSelector(spec.cursor_response_path, prev);
      if (next == null || next === "" || (Array.isArray(next) && next.length === 0)) {
        return { url: "", done: true };
      }
      cursor = String(Array.isArray(next) ? next[0] : next);
      const params: Record<string, string | number> = {
        [spec.cursor_request_param]: cursor,
      };
      if (spec.limit_param && spec.page_size != null) params[spec.limit_param] = spec.page_size;
      return buildNextPage(spec, ctx, params);
    },
    merge(acc, body) {
      if (spec.output_mode === "pages") {
        acc.push(body);
        return acc;
      }
      const arr = extractArray(body, spec.items_path);
      if (Array.isArray(arr)) acc.push(...arr);
      else acc.push(body);
      return acc;
    },
    snapshot(lastBody) {
      let nextCursor: string | null = cursor;
      if (lastBody !== null && lastBody !== undefined) {
        try {
          const v = applyPaginationSelector(spec.cursor_response_path, lastBody);
          if (v != null && v !== "" && !(Array.isArray(v) && v.length === 0)) {
            nextCursor = String(Array.isArray(v) ? v[0] : v);
          }
        } catch {}
      }
      return { kind: "cursor", cursor: nextCursor };
    },
  };
}

function buildNextPage(
  spec: OffsetSpec | PageSpec | CursorSpec,
  ctx: PageContext,
  parameters: Record<string, string | number>,
): NextPage {
  if (spec.parameter_location === "body") {
    return {
      url: buildUrl(ctx.baseUrl, ctx.baseQuery),
      done: false,
      body_parameters: parameters,
    };
  }
  return {
    url: buildUrl(ctx.baseUrl, {
      ...ctx.baseQuery,
      ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])),
    }),
    done: false,
  };
}

export async function readPaginationCheckpoint(
  tenant_id: string,
  step_row_id: string,
  db: Db,
): Promise<PaginationCheckpoint | null> {
  const rows = await db
    .select({ request_meta: executionSteps.request_meta })
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.id, step_row_id)))
    .limit(1);
  const meta = rows[0]?.request_meta as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== "object") return null;
  const cp = (meta as Record<string, unknown>).pagination_checkpoint;
  if (!cp || typeof cp !== "object") return null;
  const parsed = cp as Partial<PaginationCheckpoint>;
  if (
    !parsed.state ||
    typeof parsed.signature !== "string" ||
    typeof parsed.page_idx !== "number" ||
    typeof parsed.accumulated_count !== "number"
  ) {
    return null;
  }
  return parsed as PaginationCheckpoint;
}

export async function writePaginationCheckpoint(
  tenant_id: string,
  step_row_id: string,
  checkpoint: PaginationCheckpoint,
  db: Db,
): Promise<void> {
  const rows = await db
    .select({ request_meta: executionSteps.request_meta })
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.id, step_row_id)))
    .limit(1);
  const existing = (rows[0]?.request_meta as Record<string, unknown> | null) ?? {};
  const next = { ...existing, pagination_checkpoint: checkpoint };
  await db
    .update(executionSteps)
    .set({ request_meta: next })
    .where(and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.id, step_row_id)));
}

function extractArray(body: unknown, path?: string): unknown[] | null {
  if (body == null) return null;
  if (Array.isArray(body)) return body;
  if (path) {
    const v = applyPaginationSelector(path, body);
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    throw new Error(`pagination items path ${path} did not select an array`);
  }
  if (typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

function applyPaginationSelector(path: string, value: unknown): unknown {
  return applySelector(path.startsWith("$") ? path : `$.${path}`, value);
}
