// Audit log read-side helpers.
//
// The audit writer is append-only by design (see audit/audit.ts and
// db/audit.ts). This module is the read-only counterpart — every query
// here is scoped to a single tenant and every filter is optional. The
// SELECTs are tenant_id-first so they ride the existing
// `audit_log_tenant_ts_idx` index.
//
// Two exported entry points:
//
//   queryAuditLog  — bounded list with cursor pagination. Suitable for
//                    `GET /v1/audit-log` and the CLI `audit query` /
//                    `audit show` flows.
//   streamAuditLog — unbounded async iterator used by the ndjson export
//                    endpoint. Streams rows one at a time so a large
//                    tenant's audit trail never materialises in memory.
//
// Both helpers take a drizzle `Db` executor so callers can swap in a
// per-test database; neither touches the process-scoped pool.

import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { auditLog } from "../db/schema/audit.ts";
import type { AuditActorType, AuditEntry, AuditResult } from "./types.ts";

export interface AuditQueryFilters {
  tenant_id: string;
  actions?: string[];
  actor_id?: string;
  actor_type?: AuditActorType;
  resource_type?: string;
  resource_id?: string;
  result?: AuditResult;
  trace_id?: string;
  ts_from?: Date;
  ts_to?: Date;
}

export interface AuditQueryOptions {
  /** Page size. Defaults to 50, capped at 500. */
  limit?: number;
  /**
   * Cursor — only return rows strictly older than this timestamp.
   * The response's `next_cursor` echoes the `ts` of the last returned
   * row, so `before = <last-cursor>` walks the full history page by
   * page in chronological-desc order.
   */
  before?: Date;
}

export interface AuditQueryResult {
  items: AuditEntry[];
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function buildWhere(filters: AuditQueryFilters, before?: Date) {
  const conds = [eq(auditLog.tenant_id, filters.tenant_id)];
  if (filters.actions && filters.actions.length > 0) {
    conds.push(inArray(auditLog.action, filters.actions));
  }
  if (filters.actor_id) conds.push(eq(auditLog.actor_id, filters.actor_id));
  if (filters.actor_type) conds.push(eq(auditLog.actor_type, filters.actor_type));
  if (filters.resource_type) conds.push(eq(auditLog.resource_type, filters.resource_type));
  if (filters.resource_id) {
    // `resource_id` is `text` in the schema, but callers occasionally
    // pass uuids. Compare as text to avoid coercion surprises.
    conds.push(sql`${auditLog.resource_id}::text = ${filters.resource_id}`);
  }
  if (filters.result) conds.push(eq(auditLog.result, filters.result));
  if (filters.trace_id) conds.push(eq(auditLog.trace_id, filters.trace_id));
  if (filters.ts_from) conds.push(gte(auditLog.ts, filters.ts_from));
  if (filters.ts_to) conds.push(lte(auditLog.ts, filters.ts_to));
  if (before) conds.push(lt(auditLog.ts, before));
  return and(...conds);
}

function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    tenant_id: row.tenant_id,
    actor_type: row.actor_type as AuditActorType,
    actor_id: row.actor_id,
    action: row.action as AuditEntry["action"],
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    result: row.result as AuditResult,
    trace_id: row.trace_id ?? "",
    ip: row.ip,
    user_agent: row.user_agent,
    before: row.before,
    after: row.after,
    reason: row.reason,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Paginated tenant-scoped audit log list. `items` is ordered newest
 * first. When the page was full, `next_cursor` carries the `ts` of the
 * last returned row so the caller can request `before=<cursor>` to
 * fetch the next page.
 */
export async function queryAuditLog(
  db: Db,
  filters: AuditQueryFilters,
  opts: AuditQueryOptions = {},
): Promise<AuditQueryResult> {
  const requested = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const rows = await db
    .select()
    .from(auditLog)
    .where(buildWhere(filters, opts.before))
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(requested);
  const items = rows.map(rowToEntry);
  const next_cursor =
    rows.length === requested && rows[rows.length - 1]
      ? (rows[rows.length - 1]?.ts.toISOString() ?? null)
      : null;
  return { items, next_cursor };
}

/**
 * Fetch a single audit row by id, scoped to the caller's tenant.
 * Returns `null` when the row is missing or belongs to another tenant.
 */
export async function getAuditRowById(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<AuditEntry | null> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? rowToEntry(row) : null;
}

/**
 * Streaming variant for large exports. Walks the full result set in
 * bounded batches (500 rows each) and yields one AuditEntry at a time
 * so the caller never has to hold the full set in memory. Ordering
 * matches `queryAuditLog` — newest first, tie-broken by id.
 */
export async function* streamAuditLog(
  db: Db,
  filters: AuditQueryFilters,
): AsyncIterable<AuditEntry> {
  const batchSize = 500;
  let cursor: Date | undefined;
  // Guard against pathological tenants with millions of rows — hard cap
  // is enforced by the caller (route) via the `ts_from`/`ts_to` filter.
  while (true) {
    const rows: Array<typeof auditLog.$inferSelect> = await db
      .select()
      .from(auditLog)
      .where(buildWhere(filters, cursor))
      .orderBy(desc(auditLog.ts), desc(auditLog.id))
      .limit(batchSize);
    if (rows.length === 0) return;
    for (const r of rows) yield rowToEntry(r);
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1];
    if (!last) return;
    cursor = last.ts;
  }
}

/**
 * Serialise an audit entry for the HTTP surface. Keeps the wire shape
 * JSON-safe and predictable (`ts` becomes ISO-8601).
 */
export function serializeAuditEntry(entry: AuditEntry): Record<string, unknown> {
  return {
    id: entry.id,
    ts: entry.ts.toISOString(),
    tenant_id: entry.tenant_id,
    actor_type: entry.actor_type,
    actor_id: entry.actor_id,
    action: entry.action,
    resource_type: entry.resource_type,
    resource_id: entry.resource_id,
    result: entry.result,
    trace_id: entry.trace_id,
    ip: entry.ip,
    user_agent: entry.user_agent,
    before: entry.before,
    after: entry.after,
    reason: entry.reason,
    metadata: entry.metadata,
  };
}
