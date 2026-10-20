import { and, desc, eq, getTableColumns, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { auditLog } from "../db/schema/audit.ts";
import { scrubSecrets } from "../logging/scrub-secrets.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import { projectAuditEntry } from "./projection.ts";
import { sanitizeForAudit } from "./sanitize.ts";
import type { AuditActorType, AuditEntry, AuditResult } from "./types.ts";

export interface AuditQueryFilters {
  tenant_id: string;
  actions?: string[];
  actor_id?: string;
  actor_type?: AuditActorType;
  api_key_id?: string;
  session_id?: string;
  access_type?: string;
  oauth_client_id?: string;
  request_source?: RequestSource;
  origin_source?: RequestSource;
  execution_source?: RequestSource;
  execution_id?: string;
  conversation_id?: string;
  workflow_id?: string;
  resource_type?: string;
  resource_types?: string[];
  resource_id?: string;
  result?: AuditResult;
  trace_id?: string;
  correlation_id?: string;
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

export interface AuditResourceMatch {
  resource_type: string;
  resource_id: string;
  resource_name: string | null;
  last_seen_at: string;
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
  if (filters.api_key_id) {
    tenantConds.push(
      sql`(${auditLog.metadata}->>'audit_used_api_key_id' = ${filters.api_key_id} OR (${auditLog.metadata}->>'audit_access_type' IS NULL AND ${auditLog.metadata}->>'api_key_id' = ${filters.api_key_id}))`,
    );
  }
  if (filters.session_id) {
    tenantConds.push(
      sql`(${auditLog.metadata}->>'audit_used_session_id' = ${filters.session_id} OR (${auditLog.metadata}->>'audit_access_type' IS NULL AND ${auditLog.metadata}->>'session_id' = ${filters.session_id}))`,
    );
  }
  if (filters.access_type)
    tenantConds.push(sql`${auditLog.metadata}->>'audit_access_type' = ${filters.access_type}`);
  if (filters.oauth_client_id)
    tenantConds.push(
      sql`${auditLog.metadata}->>'audit_oauth_client_id' = ${filters.oauth_client_id}`,
    );
  if (filters.request_source) {
    tenantConds.push(sql`${auditLog.metadata}->>'request_source' = ${filters.request_source}`);
  }
  if (filters.origin_source) {
    tenantConds.push(sql`${auditLog.metadata}->>'origin_source' = ${filters.origin_source}`);
  }
  if (filters.execution_source) {
    tenantConds.push(sql`${auditLog.metadata}->>'execution_source' = ${filters.execution_source}`);
  }
  if (filters.execution_id) {
    tenantConds.push(
      sql`((${auditLog.resource_type} = 'execution' AND ${auditLog.resource_id} = ${filters.execution_id}) OR ${auditLog.metadata}->>'execution_id' = ${filters.execution_id})`,
    );
  }
  if (filters.conversation_id) {
    tenantConds.push(
      sql`((${auditLog.resource_type} = 'conversation' AND ${auditLog.resource_id} = ${filters.conversation_id}) OR ${auditLog.metadata}->>'conversation_id' = ${filters.conversation_id})`,
    );
  }
  if (filters.workflow_id) {
    tenantConds.push(
      sql`((${auditLog.resource_type} = 'workflow' AND ${auditLog.resource_id} = ${filters.workflow_id}) OR ${auditLog.metadata}->>'workflow_id' = ${filters.workflow_id})`,
    );
  }
  if (filters.resource_type) tenantConds.push(eq(auditLog.resource_type, filters.resource_type));
  if (filters.resource_types?.length) {
    tenantConds.push(inArray(auditLog.resource_type, filters.resource_types));
  }
  if (filters.resource_id) {
    tenantConds.push(sql`${auditLog.resource_id}::text = ${filters.resource_id}`);
  }
  if (filters.result) tenantConds.push(eq(auditLog.result, filters.result));
  if (filters.trace_id) tenantConds.push(eq(auditLog.trace_id, filters.trace_id));
  if (filters.correlation_id) {
    tenantConds.push(sql`${auditLog.metadata}->>'audit_trace_id' = ${filters.correlation_id}`);
  }
  if (filters.ts_from) tenantConds.push(gte(auditLog.ts, filters.ts_from));
  if (filters.ts_to) tenantConds.push(lt(auditLog.ts, filters.ts_to));
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
    .limit(requested + 1);
  const page = rows.slice(0, requested);
  const items = page.map(rowToEntry);
  const last = page[page.length - 1];
  const next_cursor =
    rows.length > requested && last ? formatAuditCursor({ ts: last.ts_cursor, id: last.id }) : null;
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

export async function searchAuditResources(
  db: Db,
  tenant_id: string,
  search: string,
  resource_type?: string,
  limit = 30,
): Promise<AuditResourceMatch[]> {
  const escaped = search.replace(/[\\%_]/g, "\\$&");
  const pattern = `%${escaped}%`;
  const pageSize = 100;
  const maximum = Math.max(1, Math.min(limit, 30));
  const found: AuditResourceMatch[] = [];
  const needle = search.toLocaleLowerCase();
  for (let offset = 0; found.length < maximum; offset += pageSize) {
    const result = await db.execute(sql`
    WITH matches AS (
      SELECT a.resource_type, a.resource_id, max(a.ts) AS last_seen_at,
        array_agg(DISTINCT historical.resource_name)
          FILTER (WHERE historical.resource_name ILIKE ${pattern}) AS matching_names
      FROM audit_log a
      CROSS JOIN LATERAL (VALUES
        (CASE a.resource_type
          WHEN 'workflow' THEN a.after->>'name'
          WHEN 'connector' THEN coalesce(a.after->>'display_name', a.after->>'name')
          WHEN 'knowledge_source' THEN a.after->>'name'
          WHEN 'skill' THEN coalesce(a.after->>'title', a.after->>'name')
          WHEN 'file' THEN a.after->>'filename'
          WHEN 'conversation' THEN a.after->>'title'
        END),
        (CASE a.resource_type
          WHEN 'workflow' THEN a.before->>'name'
          WHEN 'connector' THEN coalesce(a.before->>'display_name', a.before->>'name')
          WHEN 'knowledge_source' THEN a.before->>'name'
          WHEN 'skill' THEN coalesce(a.before->>'title', a.before->>'name')
          WHEN 'file' THEN a.before->>'filename'
          WHEN 'conversation' THEN a.before->>'title'
        END)
      ) AS historical(resource_name)
      WHERE a.tenant_id = ${tenant_id}::uuid
        AND a.resource_id IS NOT NULL
        AND a.resource_type IN ('workflow', 'connector', 'knowledge_source', 'skill', 'file', 'conversation')
        AND (${resource_type ?? null}::text IS NULL OR a.resource_type = ${resource_type ?? null})
        AND (a.resource_id ILIKE ${pattern} OR historical.resource_name ILIKE ${pattern})
      GROUP BY a.resource_type, a.resource_id
      ORDER BY max(a.ts) DESC, a.resource_type, a.resource_id
      LIMIT ${pageSize} OFFSET ${offset}
    )
    SELECT matches.resource_type, matches.resource_id, latest.resource_name,
      matches.matching_names, matches.last_seen_at
    FROM matches
    LEFT JOIN LATERAL (
      SELECT candidate.resource_name
      FROM (
        SELECT coalesce(
          nullif(btrim(CASE a.resource_type
          WHEN 'workflow' THEN a.after->>'name'
          WHEN 'connector' THEN coalesce(a.after->>'display_name', a.after->>'name')
          WHEN 'knowledge_source' THEN a.after->>'name'
          WHEN 'skill' THEN coalesce(a.after->>'title', a.after->>'name')
          WHEN 'file' THEN a.after->>'filename'
          WHEN 'conversation' THEN a.after->>'title'
          END), ''),
          nullif(btrim(CASE a.resource_type
          WHEN 'workflow' THEN a.before->>'name'
          WHEN 'connector' THEN coalesce(a.before->>'display_name', a.before->>'name')
          WHEN 'knowledge_source' THEN a.before->>'name'
          WHEN 'skill' THEN coalesce(a.before->>'title', a.before->>'name')
          WHEN 'file' THEN a.before->>'filename'
          WHEN 'conversation' THEN a.before->>'title'
          END), '')
        ) AS resource_name, a.ts, a.id
        FROM audit_log a
        WHERE a.tenant_id = ${tenant_id}::uuid
          AND a.resource_type = matches.resource_type
          AND a.resource_id = matches.resource_id
      ) candidate
      ORDER BY candidate.resource_name IS NOT NULL DESC, candidate.ts DESC, candidate.id DESC
      LIMIT 1
    ) latest ON true
    ORDER BY matches.last_seen_at DESC, matches.resource_type, matches.resource_id
    `);
    for (const raw of result.rows) {
      const row = raw as {
        resource_type: string;
        resource_id: string;
        resource_name: string | null;
        matching_names: string[] | null;
        last_seen_at: Date;
      };
      if (
        !row.resource_id.toLocaleLowerCase().includes(needle) &&
        !(row.matching_names ?? []).some((name) =>
          sanitizeForAudit(String(scrubSecrets(name)))
            .toLocaleLowerCase()
            .includes(needle),
        )
      )
        continue;
      found.push({
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        resource_name: row.resource_name?.trim()
          ? sanitizeForAudit(String(scrubSecrets(row.resource_name)))
          : null,
        last_seen_at: new Date(row.last_seen_at).toISOString(),
      });
      if (found.length === maximum) break;
    }
    if (result.rows.length < pageSize) break;
  }
  return found;
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
  return projectAuditEntry(entry);
}
