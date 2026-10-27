import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { type Executor, getDb } from "../db/client.ts";
import {
  beforeKeyset,
  cursorTimestamp,
  formatKeysetCursor,
  parseKeysetCursor,
} from "../db/keyset-cursor.ts";
import { executionSteps, executions, workflows } from "../db/schema/index.ts";
import { executionVisibilityFilter } from "./execution-owner.ts";

export type ExecutionRow = typeof executions.$inferSelect;

export interface ListExecutionsOptions {
  limit?: number;
  cursor?: string;
  workflow_id?: string;
  status?: string;
  request_source?: string;
  parent_execution_id?: string;
  q?: string;
  started_from?: Date;
  started_to?: Date;
  held_effects?: boolean;
  principal?: ResolvedPrincipal;
}

export const EXECUTION_LIST_MAX_LIMIT = 200;
export const EXECUTION_LIST_DEFAULT_LIMIT = 50;

function buildExecutionListFilters(tenant_id: string, opts: ListExecutionsOptions, db: Executor) {
  const conds = [];
  if (opts.workflow_id) conds.push(eq(executions.workflow_id, opts.workflow_id));
  const statuses = (opts.status ?? "")
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean) as ExecutionRow["status"][];
  if (statuses.length === 1)
    conds.push(eq(executions.status, statuses[0] as ExecutionRow["status"]));
  else if (statuses.length > 1) conds.push(inArray(executions.status, statuses));
  if (opts.request_source) conds.push(eq(executions.request_source, opts.request_source));
  if (opts.parent_execution_id)
    conds.push(eq(executions.parent_execution_id, opts.parent_execution_id));
  if (opts.started_from) conds.push(gte(executions.started_at, opts.started_from));
  if (opts.started_to) conds.push(lt(executions.started_at, opts.started_to));
  if (opts.held_effects !== undefined) {
    const hasHeldEffects = sql`exists (
      select 1
      from ${executionSteps}
      where ${executionSteps.tenant_id} = ${tenant_id}
        and ${executionSteps.execution_id} = ${executions.id}
        and (
          ${executionSteps.held} = true
          or ${executionSteps.request_meta}->'extras'->>'held' = 'true'
        )
    )`;
    conds.push(opts.held_effects ? hasHeldEffects : sql`not (${hasHeldEffects})`);
  }
  if (opts.principal) conds.push(executionVisibilityFilter(opts.principal));
  const needle = opts.q?.trim();
  if (needle) {
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
  rows: ExecutionRow[];
  total: number;
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
