import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executionSteps } from "../db/schema/index.ts";
import { applySelector } from "./selectors.ts";

export const MAX_PAGES = 1000;
export const PAGE_PROGRESS_INTERVAL = 50;

export const PAGINATION_CHECKPOINT_INTERVAL: number = (() => {
  const raw = process.env.PAGINATION_CHECKPOINT_INTERVAL;
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
})();

export interface PageContext {
  baseUrl: URL;
  baseQuery: Record<string, string>;
}

export interface NextPage {
  url: string;
  done: boolean;
  body_parameters?: Record<string, string | number>;
}

export interface PaginationStrategyState {
  next(prevResponse: unknown, pageIdx: number): NextPage;
  merge(acc: unknown[], pageBody: unknown): unknown[];
  snapshot(lastBody: unknown): PaginationCheckpointState;
}

export type PaginationCheckpointState =
  | { kind: "offset"; offset: number }
  | { kind: "page"; page: number }
  | { kind: "cursor"; cursor: string | null };

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

export type PaginationSpec = OffsetSpec | PageSpec | CursorSpec;

export function makeStrategy(spec: PaginationSpec, ctx: PageContext): PaginationStrategyState {
  if (spec.strategy === "offset") {
    let offset = 0;
    return {
      next(prev, idx) {
        if (idx === 0) {
          offset = 0;
          return buildNextPage(spec, ctx, {
            [spec.offset_param]: offset,
            [spec.limit_param]: spec.page_size,
          });
        }
        const arr = extractArray(prev, spec.items_path ?? spec.stop_when_empty_path);
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
      next(prev, idx) {
        if (idx === 0) {
          page = spec.start_page;
          return buildNextPage(spec, ctx, {
            [spec.page_param]: page,
            [spec.limit_param]: spec.page_size,
          });
        }
        const arr = extractArray(prev, spec.items_path);
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
  spec: PaginationSpec,
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
