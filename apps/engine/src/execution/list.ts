// Canonical tenant-scoped execution list. Executions are an unbounded
// history (unlike the workflow/connector/schedule catalogs), so this
// surface keeps paging — but every page carries the exact `total` under
// the same filters so no consumer can mistake a page for the universe.
//
// Single query: `count(*) over ()` rides along the row select. The HTTP
// route (`http/routes/executions/list.ts`), the in-process EngineClient,
// and the conversation `list_executions` tool all read from here so the
// filter surface cannot drift between them.

import { and, desc, eq, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { type ListResult, resolveWindowTotal, totalOverWindow } from "../db/list-result.ts";
import { executions } from "../db/schema/index.ts";

export type ExecutionRow = typeof executions.$inferSelect;

export interface ListExecutionsOptions {
  limit?: number;
  offset?: number;
  workflow_id?: string;
  status?: string;
  request_source?: string;
  /** Lineage filter: list the reruns spawned from this execution. */
  parent_execution_id?: string;
}

export const EXECUTION_LIST_MAX_LIMIT = 200;
export const EXECUTION_LIST_DEFAULT_LIMIT = 50;

/** Optional filters only — the tenant predicate is composed visibly at
 *  each query site so the tenant_filter invariant can verify it. */
function buildExecutionListFilters(opts: ListExecutionsOptions) {
  const conds = [];
  if (opts.workflow_id) conds.push(eq(executions.workflow_id, opts.workflow_id));
  if (opts.status) conds.push(eq(executions.status, opts.status as ExecutionRow["status"]));
  if (opts.request_source) conds.push(eq(executions.request_source, opts.request_source));
  if (opts.parent_execution_id)
    conds.push(eq(executions.parent_execution_id, opts.parent_execution_id));
  return conds;
}

export async function listExecutions(
  tenant_id: string,
  opts: ListExecutionsOptions = {},
  exec?: Executor,
): Promise<ListResult<ExecutionRow>> {
  const db = exec ?? getDb();
  const limit = Math.min(opts.limit ?? EXECUTION_LIST_DEFAULT_LIMIT, EXECUTION_LIST_MAX_LIMIT);
  const offset = opts.offset ?? 0;
  const filters = buildExecutionListFilters(opts);
  const rows = await db
    .select({ row: executions, total: totalOverWindow() })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), ...filters))
    .orderBy(desc(executions.created_at))
    .limit(limit)
    .offset(offset);
  const total = await resolveWindowTotal(rows, offset, async () => {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(executions)
      .where(and(eq(executions.tenant_id, tenant_id), ...filters));
    return Number(row?.c ?? 0);
  });
  return { rows: rows.map((r) => r.row), total };
}
