import { and, desc, eq, getTableColumns, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { auditLog } from "../db/schema/audit.ts";
import { auditResourceName } from "./resource-name.ts";
import type { AuditActorType, AuditEntry, AuditResult } from "./types.ts";

export interface AuditQueryFilters {
  tenant_id: string;
  actions?: string[];
  actor_id?: string;
  actor_type?: AuditActorType;
  resource_type?: string;
  resource_types?: string[];
  resource_id?: string;
  result?: AuditResult;
  trace_id?: string;
  ts_from?: Date;
  ts_to?: Date;
}

export interface AuditQueryOptions {
  limit?: number;
  cursor?: string;
}

export interface AuditQueryResult {
  items: AuditEntry[];
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface AuditKeysetCursor {
  ts: string;
  id: string;
}

const CURSOR_TS_SQL = sql<string>`to_char(${auditLog.ts} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const MIN_UUID = "00000000-0000-0000-0000-000000000000";

function formatAuditCursor(c: AuditKeysetCursor): string {
  return `${c.ts}|${c.id}`;
}

export const AUDIT_CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z(?:\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$/;

export class InvalidAuditCursorError extends Error {
  constructor(raw: string) {
    super(`invalid audit cursor: ${JSON.stringify(raw)}`);
    this.name = "InvalidAuditCursorError";
  }
}

export function parseAuditCursor(raw: string): AuditKeysetCursor | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!AUDIT_CURSOR_PATTERN.test(trimmed)) throw new InvalidAuditCursorError(raw);
  const sep = trimmed.lastIndexOf("|");
  if (sep === -1) return { ts: trimmed, id: MIN_UUID };
  return { ts: trimmed.slice(0, sep), id: trimmed.slice(sep + 1) };
}

function buildWhere(filters: AuditQueryFilters, before?: AuditKeysetCursor) {
  const tenantConds = [eq(auditLog.tenant_id, filters.tenant_id)];
  if (filters.actions && filters.actions.length > 0) {
    tenantConds.push(inArray(auditLog.action, filters.actions));
  }
  if (filters.actor_id) tenantConds.push(eq(auditLog.actor_id, filters.actor_id));
  if (filters.actor_type) tenantConds.push(eq(auditLog.actor_type, filters.actor_type));
  if (filters.resource_type) tenantConds.push(eq(auditLog.resource_type, filters.resource_type));
  if (filters.resource_types?.length) {
    tenantConds.push(inArray(auditLog.resource_type, filters.resource_types));
  }
  if (filters.resource_id) {
    tenantConds.push(sql`${auditLog.resource_id}::text = ${filters.resource_id}`);
  }
  if (filters.result) tenantConds.push(eq(auditLog.result, filters.result));
  if (filters.trace_id) tenantConds.push(eq(auditLog.trace_id, filters.trace_id));
  if (filters.ts_from) tenantConds.push(gte(auditLog.ts, filters.ts_from));
  if (filters.ts_to) tenantConds.push(lte(auditLog.ts, filters.ts_to));
  if (before) {
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

export async function queryAuditLog(
  db: Db,
  filters: AuditQueryFilters,
  opts: AuditQueryOptions = {},
): Promise<AuditQueryResult> {
  const requested = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const before = opts.cursor === undefined ? undefined : parseAuditCursor(opts.cursor);
  const rows = await db
    .select({ ...getTableColumns(auditLog), ts_cursor: CURSOR_TS_SQL.as("ts_cursor") })
    .from(auditLog)
    .where(buildWhere(filters, before))
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(requested);
  const items = rows.map(rowToEntry);
  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length === requested && last
      ? formatAuditCursor({ ts: last.ts_cursor, id: last.id })
      : null;
  return { items, next_cursor };
}

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

export async function* streamAuditLog(
  db: Db,
  filters: AuditQueryFilters,
): AsyncIterable<AuditEntry> {
  const batchSize = 500;
  let cursor: AuditKeysetCursor | undefined;
  while (true) {
    const rows = await db
      .select({
        ...getTableColumns(auditLog),
        ts_cursor: CURSOR_TS_SQL.as("ts_cursor"),
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
    cursor = { ts: last.ts_cursor, id: last.id };
  }
}

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
    resource_name: auditResourceName(entry),
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
