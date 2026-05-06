// Pagination loop helpers. The request step driver hands each page-fetch
// call back to a strategy object that decides:
//   - the URL/query for the next page
//   - whether to stop (empty page, page count cap, missing cursor)
// All three strategies cap at 1,000 requests per step.
//
// Checkpointing: every PAGINATION_CHECKPOINT_INTERVAL pages the strategy
// state is persisted to `execution_steps.request_meta.pagination_checkpoint`
// so a long-paginated request can resume after engine restart / step timeout
// instead of restarting from page 1. The checkpoint includes a request
// signature hash so a re-authored workflow doesn't accidentally pick up a
// stale resume position.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executionSteps } from "../db/schema/index.ts";
import { applySelector } from "./selectors.ts";

export const MAX_PAGES = 1000;
export const PAGE_PROGRESS_INTERVAL = 50;

/** Pages between checkpoint writes. Tunable via env so an operator can
 *  trade write amplification against blast radius on a restart. */
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
}

export interface PaginationStrategyState {
  next(prevResponse: unknown, pageIdx: number): NextPage;
  merge(acc: unknown[], pageBody: unknown): unknown[];
  /** Snapshot of the strategy's internal cursor/offset/page state — captured
   *  AFTER `merge()` so the value reflects the next URL to fetch on resume.
   *  `lastBody` is the most recently fetched page body (cursor strategies
   *  read the next cursor from it; offset/page strategies ignore it). */
  snapshot(lastBody: unknown): PaginationCheckpointState;
}

/** The strategy-specific state that, together with the request signature,
 *  uniquely identifies "where are we in this paginated request". */
export type PaginationCheckpointState =
  | { kind: "offset"; offset: number }
  | { kind: "page"; page: number }
  | { kind: "cursor"; cursor: string | null };

/** What gets persisted to `execution_steps.request_meta.pagination_checkpoint`.
 *  `signature` is a sha256 of the request shape so a workflow re-author that
 *  flips a query param doesn't accidentally resume against the new shape. */
export interface PaginationCheckpoint {
  state: PaginationCheckpointState;
  /** Page index of the LAST successfully fetched page. The next page-fetch
   *  on resume is `page_idx + 1`. */
  page_idx: number;
  /** Number of records collected in `acc` so far. */
  accumulated_count: number;
  /** Hash of the request signature (base_url + path_or_url + query). */
  signature: string;
  /** ISO-8601 timestamp the checkpoint was written. */
  written_at: string;
}

export function paginationSignature(input: {
  base_url: string;
  path_or_url: string;
  query: Record<string, unknown>;
}): string {
  // Stable JSON: sort query keys so {a,b} and {b,a} hash identically.
  const sortedQuery: Record<string, unknown> = {};
  for (const k of Object.keys(input.query).sort()) {
    sortedQuery[k] = input.query[k];
  }
  const payload = JSON.stringify({
    base_url: input.base_url,
    path_or_url: input.path_or_url,
    query: sortedQuery,
  });
  return createHash("sha256").update(payload).digest("hex");
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

export function makeStrategy(
  spec: PaginationSpec,
  ctx: PageContext,
  seed?: PaginationCheckpointState | null,
): PaginationStrategyState {
  // On a seeded resume the strategy's internal counter holds "the last page
  // that was successfully fetched". The first next() call after a resume must
  // therefore advance to the *following* page before emitting the URL — that
  // matches the steady-state semantics where next() emits "what to fetch
  // now". Plain (non-seeded) starts initialise to the user-declared origin
  // and emit the very first page on idx=0.
  if (spec.strategy === "offset") {
    const seeded = seed && seed.kind === "offset";
    let offset = seeded ? seed.offset : 0;
    return {
      next(prev, idx) {
        if (idx === 0) {
          if (seeded) {
            offset += spec.page_size;
          } else {
            offset = 0;
          }
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
      snapshot(_lastBody) {
        return { kind: "offset", offset };
      },
    };
  }
  if (spec.strategy === "page") {
    const seeded = seed && seed.kind === "page";
    let page = seeded ? seed.page : spec.start_page;
    return {
      next(prev, idx) {
        if (idx === 0) {
          if (seeded) {
            page += 1;
          } else {
            page = spec.start_page;
          }
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
      snapshot(_lastBody) {
        return { kind: "page", page };
      },
    };
  }
  // cursor
  // For cursor pagination the snapshot stores "the cursor to USE for the next
  // page" — not the cursor that was just used. The next cursor only becomes
  // available after a page fetch (it's read out of the response body via
  // `cursor_response_path`), so we capture it after the URL is built and
  // expose it via snapshot(). On resume the seeded value is fed straight
  // into the next URL.
  const seededCursor = seed && seed.kind === "cursor" ? seed.cursor : null;
  let cursor: string | null = seededCursor;
  return {
    next(prev, idx) {
      if (idx === 0) {
        const params: Record<string, string> = { ...ctx.baseQuery };
        if (cursor !== null) params[spec.cursor_request_param] = cursor;
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
    snapshot(lastBody) {
      // Read the *next* cursor from the most recently fetched page body so a
      // resume can jump straight to the following URL. If the body has no
      // cursor field the response is treated as terminal and the snapshot
      // records `null` — a resumed strategy will then start fresh.
      let nextCursor: string | null = cursor;
      if (lastBody !== null && lastBody !== undefined) {
        try {
          const v = applySelector(spec.cursor_response_path, lastBody);
          if (v != null && v !== "" && !(Array.isArray(v) && v.length === 0)) {
            nextCursor = String(Array.isArray(v) ? v[0] : v);
          }
        } catch {
          // Selector failures fall through to the existing `cursor` value.
        }
      }
      return { kind: "cursor", cursor: nextCursor };
    },
  };
}

// ---------------------------------------------------------------------------
// Checkpoint persistence — read/write helpers for the request step.
// ---------------------------------------------------------------------------

/** Read the current pagination checkpoint for a step row. Returns null when
 *  no row exists, no `request_meta`, or no checkpoint subkey. */
export async function readPaginationCheckpoint(
  step_row_id: string,
  db: Db,
): Promise<PaginationCheckpoint | null> {
  // tenant-filter:exempt — tenant-scoped via parent execution_id; verified by caller
  const rows = await db
    .select({ request_meta: executionSteps.request_meta })
    .from(executionSteps)
    .where(eq(executionSteps.id, step_row_id))
    .limit(1);
  const meta = rows[0]?.request_meta as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== "object") return null;
  const cp = (meta as Record<string, unknown>).pagination_checkpoint;
  if (!cp || typeof cp !== "object") return null;
  // Trust the persisted shape — it was written by writePaginationCheckpoint
  // from this same module. Defensive parse instead of zod to keep the hot
  // path allocation-light.
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

/** Merge a `pagination_checkpoint` blob into `execution_steps.request_meta`,
 *  preserving every other key that was already there. We fetch + merge +
 *  update to keep this code-path drizzle-pure (no raw SQL); the row is
 *  point-locked by primary key so the merge is contention-safe in the steady
 *  state of one-writer-per-step. */
export async function writePaginationCheckpoint(
  step_row_id: string,
  checkpoint: PaginationCheckpoint,
  db: Db,
): Promise<void> {
  // tenant-filter:exempt — tenant-scoped via parent execution_id; verified by caller
  const rows = await db
    .select({ request_meta: executionSteps.request_meta })
    .from(executionSteps)
    .where(eq(executionSteps.id, step_row_id))
    .limit(1);
  const existing = (rows[0]?.request_meta as Record<string, unknown> | null) ?? {};
  const next = { ...existing, pagination_checkpoint: checkpoint };
  await db
    .update(executionSteps)
    .set({ request_meta: next })
    .where(eq(executionSteps.id, step_row_id));
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
