// Canonical tenant-scoped execution list. Executions are an unbounded
// history (unlike the workflow/connector/schedule catalogs), so this
// surface pages by KEYSET cursor over `(created_at DESC, id DESC)` — an
// offset shifts under every run that starts while a reader pages, and
// shows one row twice or skips it. Every page still carries the exact
// `total` under the same filters so no consumer can mistake a page for
// the universe (the cursor narrows the rows, never the total). The HTTP
// route (`http/routes/executions/list.ts`), the in-process EngineClient,
// and the conversation `list_executions` tool all read from here so the
// filter surface cannot drift between them.

import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import {
  beforeKeyset,
  cursorTimestamp,
  formatKeysetCursor,
  parseKeysetCursor,
} from "../db/keyset-cursor.ts";
import { executions, workflows } from "../db/schema/index.ts";

export type ExecutionRow = typeof executions.$inferSelect;

export interface ListExecutionsOptions {
  limit?: number;
  /** Opaque `next_cursor` of a previous page, passed back verbatim. */
  cursor?: string;
  workflow_id?: string;
  status?: string;
  request_source?: string;
  /** Lineage filter: list the reruns spawned from this execution. */
  parent_execution_id?: string;
  /**
   * Free text, matched against the workflow a run belongs to.
   *
   * A run has no name of its own — it is an instance of a workflow at a moment
   * — so the only thing a person can search for here is the workflow's name or
   * slug. Without this the Cockpit could only narrow the page it had already
   * fetched, which looks like search and is not: a run outside the first fifty
   * rows was unreachable by name.
   */
  q?: string;
  /**
   * A window on `started_at`: from (inclusive) and to (exclusive). The same
   * field and the same bounds `GET /v1/stats/executions` counts on, so a
   * figure computed over a window and the list it links to hold the same runs.
   * A run that never started has no `started_at` and is outside any window.
   */
  started_from?: Date;
  started_to?: Date;
}

export const EXECUTION_LIST_MAX_LIMIT = 200;
export const EXECUTION_LIST_DEFAULT_LIMIT = 50;

/** Optional filters only — the tenant predicate is composed visibly at
 *  each query site so the tenant_filter invariant can verify it. */
function buildExecutionListFilters(tenant_id: string, opts: ListExecutionsOptions, db: Executor) {
  const conds = [];
  if (opts.workflow_id) conds.push(eq(executions.workflow_id, opts.workflow_id));
  if (opts.status) conds.push(eq(executions.status, opts.status as ExecutionRow["status"]));
  if (opts.request_source) conds.push(eq(executions.request_source, opts.request_source));
  if (opts.parent_execution_id)
    conds.push(eq(executions.parent_execution_id, opts.parent_execution_id));
  if (opts.started_from) conds.push(gte(executions.started_at, opts.started_from));
  if (opts.started_to) conds.push(lt(executions.started_at, opts.started_to));
  const needle = opts.q?.trim();
  if (needle) {
    // The workflow carries the name, so the search reaches through the id. The
    // subquery is tenant-scoped in its own right: a needle must never be able
    // to pull a run whose workflow belongs to someone else into the answer.
    conds.push(
      inArray(
        executions.workflow_id,
        db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.tenant_id, tenant_id),
              or(ilike(workflows.name, `%${needle}%`), ilike(workflows.slug, `%${needle}%`)),
            ),
          ),
      ),
    );
  }
  return conds;
}

export interface ExecutionListResult {
  /** The page, newest first. */
  rows: ExecutionRow[];
  /** Exact count under the filters, independent of limit and cursor. */
  total: number;
  /** Cursor for the next page; null when this page reached the end. */
  next_cursor: string | null;
}

export async function listExecutions(
  tenant_id: string,
  opts: ListExecutionsOptions = {},
  exec?: Executor,
): Promise<ExecutionListResult> {
  const db = exec ?? getDb();
  const limit = Math.min(opts.limit ?? EXECUTION_LIST_DEFAULT_LIMIT, EXECUTION_LIST_MAX_LIMIT);
  const filters = buildExecutionListFilters(tenant_id, opts, db);
  const cursor = opts.cursor ? parseKeysetCursor(opts.cursor) : undefined;
  // One row past the page tells whether a next page exists; the total is
  // its own count so a cursor never narrows it. Sequential, not parallel:
  // the executor may be a transaction holding a single connection.
  const rows = await db
    .select({ row: executions, ts_cursor: cursorTimestamp(executions.created_at) })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        ...filters,
        ...(cursor ? [beforeKeyset(executions.created_at, executions.id, cursor)] : []),
      ),
    )
    .orderBy(desc(executions.created_at), desc(executions.id))
    .limit(limit + 1);
  const counted = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), ...filters));
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next_cursor =
    rows.length > limit && last
      ? formatKeysetCursor({ ts: last.ts_cursor, id: last.row.id })
      : null;
  return { rows: page.map((r) => r.row), total: Number(counted[0]?.c ?? 0), next_cursor };
}
