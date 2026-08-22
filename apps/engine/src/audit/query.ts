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

import { and, desc, eq, getTableColumns, gte, inArray, lt, lte, sql } from "drizzle-orm";
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

/**
 * Keyset cursor for the export walk.
 *
 * `ts` is the Postgres rendering of the column (`timestamptz::text`),
 * NOT a JS `Date`: `Date` holds milliseconds while the column holds
 * microseconds, so a cursor round-tripped through the driver loses up
 * to 999µs and steps past unread rows. Keeping the value as the text
 * Postgres produced and casting it back preserves the column exactly.
 *
 * `id` is the tiebreaker. Without it a boundary that lands inside a
 * group of rows sharing one `ts` — the normal case, since `audit()`
 * stamps `ts` from the JS clock for every row a request writes — drops
 * the rest of that group.
 */
interface AuditKeysetCursor {
  /** `timestamptz::text` as Postgres rendered it, full precision. */
  ts: string;
  id: string;
}

function buildWhere(filters: AuditQueryFilters, before?: Date | AuditKeysetCursor) {
  const tenantConds = [eq(auditLog.tenant_id, filters.tenant_id)];
  if (filters.actions && filters.actions.length > 0) {
    tenantConds.push(inArray(auditLog.action, filters.actions));
  }
  if (filters.actor_id) tenantConds.push(eq(auditLog.actor_id, filters.actor_id));
  if (filters.actor_type) tenantConds.push(eq(auditLog.actor_type, filters.actor_type));
  if (filters.resource_type) tenantConds.push(eq(auditLog.resource_type, filters.resource_type));
  if (filters.resource_id) {
    // `resource_id` is `text` in the schema, but callers occasionally
    // pass uuids. Compare as text to avoid coercion surprises.
    tenantConds.push(sql`${auditLog.resource_id}::text = ${filters.resource_id}`);
  }
  if (filters.result) tenantConds.push(eq(auditLog.result, filters.result));
  if (filters.trace_id) tenantConds.push(eq(auditLog.trace_id, filters.trace_id));
  if (filters.ts_from) tenantConds.push(gte(auditLog.ts, filters.ts_from));
  if (filters.ts_to) tenantConds.push(lte(auditLog.ts, filters.ts_to));
  if (before instanceof Date) {
    tenantConds.push(lt(auditLog.ts, before));
  } else if (before) {
    // Row-wise comparison, matching `ORDER BY ts DESC, id DESC` exactly:
    // "strictly after the last row I emitted", with the tiebreaker.
    tenantConds.push(
      sql`(${auditLog.ts}, ${auditLog.id}) < (${before.ts}::timestamptz, ${before.id}::uuid)`,
    );
  }
  return and(...tenantConds);
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
 *
 * The batch boundary rides a KEYSET cursor `(ts, id)` carrying the
 * timestamp as Postgres text. A cursor of `ts` alone silently truncated
 * the export twice over — see `AuditKeysetCursor` and
 * `tests/export-completeness.integration.test.ts`, which pins the emitted
 * set against `count(*)`.
 */
export async function* streamAuditLog(
  db: Db,
  filters: AuditQueryFilters,
): AsyncIterable<AuditEntry> {
  const batchSize = 500;
  let cursor: AuditKeysetCursor | undefined;
  // Guard against pathological tenants with millions of rows — hard cap
  // is enforced by the caller (route) via the `ts_from`/`ts_to` filter.
  while (true) {
    const rows = await db
      .select({
        ...getTableColumns(auditLog),
        // The column as Postgres renders it, so the next cursor keeps
        // the microseconds the driver's Date would drop.
        ts_text: sql<string>`${auditLog.ts}::text`,
      })
      .from(auditLog)
      .where(buildWhere(filters, cursor))
      .orderBy(desc(auditLog.ts), desc(auditLog.id))
      .limit(batchSize);
    if (rows.length === 0) return;
    for (const r of rows) yield rowToEntry(r);
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1];
    if (!last) return;
    cursor = { ts: last.ts_text, id: last.id };
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
