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

import { and, desc, eq, getTableColumns, gte, inArray, lte, sql } from "drizzle-orm";

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
   * OPAQUE cursor from a previous response's `next_cursor`. Pass it
   * back verbatim; do not parse it, build it, or compare it. It encodes
   * both halves of the sort key — see `AuditKeysetCursor` for why a
   * timestamp alone silently drops rows.
   */
  before?: string;
}

export interface AuditQueryResult {
  items: AuditEntry[];
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Keyset cursor — the ONE cursor shape every read path over `audit_log`
 * uses. There is deliberately no timestamp-only variant left to choose:
 * the first repair added this branch next to the old one and only moved
 * the export onto it, so the paged list kept losing 9 rows in 15 for
 * another round. A broken branch that still exists is the default for
 * the next reader.
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

/** Renders `ts` with microsecond precision and no space/offset, so the
 *  cursor survives a URL query value and casts straight back. */
const CURSOR_TS_SQL = sql<string>`to_char(${auditLog.ts} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** All-zero uuid — sorts below every real id. */
const MIN_UUID = "00000000-0000-0000-0000-000000000000";

function formatAuditCursor(c: AuditKeysetCursor): string {
  return `${c.ts}|${c.id}`;
}

/**
 * The cursor's shape, as one regex: an ISO-8601 UTC timestamp with up to
 * microsecond precision, optionally followed by `|<uuid>`.
 *
 * LOCAL-SK-CURSOR-MUELL-500 — the route's `before` param was widened from
 * `.datetime()` to `.min(1).max(128)` so the keyset form would pass, and
 * nothing took over the shape check. `"abc|def"` then reached the SQL cast
 * (`'abc'::timestamptz`), which throws: a client error reported as a 500 and
 * filed in the operator diagnostics register. The envelope is generic — no
 * SQL leaks — but the status was a lie about whose fault it was.
 *
 * This constant is the single definition of the shape. The HTTP layer builds
 * its Zod validator from it (so the rejection is a 400 with an OpenAPI
 * `pattern`), and `parseAuditCursor` enforces it again for every non-HTTP
 * caller.
 */
export const AUDIT_CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z(?:\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$/;

/** A `before` value that is not a cursor. Thrown rather than swallowed: a
 *  parser that answered `undefined` would mean "no cursor", i.e. silently
 *  serving page one to a caller who asked for page five — the same class of
 *  quiet wrongness the cursor itself was repaired for. */
export class InvalidAuditCursorError extends Error {
  constructor(raw: string) {
    super(`invalid audit cursor: ${JSON.stringify(raw)}`);
    this.name = "InvalidAuditCursorError";
  }
}

/**
 * Parse a `next_cursor` handed back by a caller.
 *
 * A cursor minted before the keyset change carries only a timestamp.
 * It is NOT rejected and NOT routed to a second predicate — it is
 * widened to `(ts, MIN_UUID)`, which through the one row-wise
 * comparison means exactly `ts < cursor`: the old behaviour, for the
 * only cursors that cannot do better, expressed in the new shape.
 * That way there is still just one predicate to reason about.
 *
 * An empty value still means "no cursor". Anything else that is not the
 * shape above throws — see `AUDIT_CURSOR_PATTERN`.
 */
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
  if (filters.resource_id) {
    // `resource_id` is `text` in the schema, but callers occasionally
    // pass uuids. Compare as text to avoid coercion surprises.
    tenantConds.push(sql`${auditLog.resource_id}::text = ${filters.resource_id}`);
  }
  if (filters.result) tenantConds.push(eq(auditLog.result, filters.result));
  if (filters.trace_id) tenantConds.push(eq(auditLog.trace_id, filters.trace_id));
  if (filters.ts_from) tenantConds.push(gte(auditLog.ts, filters.ts_from));
  if (filters.ts_to) tenantConds.push(lte(auditLog.ts, filters.ts_to));
  if (before) {
    // The only cursor predicate. Row-wise comparison, matching
    // `ORDER BY ts DESC, id DESC` exactly: "strictly after the last row
    // I emitted", with the tiebreaker that a bare timestamp lacks.
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
 * first. When the page was FULL, `next_cursor` carries the last returned
 * row's rendered timestamp AND its id (`<ts>|<uuid>`); the caller passes it
 * back verbatim as `before=<cursor>`. A short page returns `null`.
 *
 * This header used to say the cursor carries "the `ts` of the last returned
 * row". That was the shape that dropped every remaining member of a
 * timestamp tie — 6 rows of 15 reached by a full walk. The route header one
 * file over was corrected when the code was; this one was not, and a stale
 * description of a cursor is exactly what the next reader builds against.
 * See `AuditKeysetCursor` for why the id is not optional.
 */
export async function queryAuditLog(
  db: Db,
  filters: AuditQueryFilters,
  opts: AuditQueryOptions = {},
): Promise<AuditQueryResult> {
  const requested = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const before = opts.before === undefined ? undefined : parseAuditCursor(opts.before);
  const rows = await db
    .select({ ...getTableColumns(auditLog), ts_cursor: CURSOR_TS_SQL.as("ts_cursor") })
    .from(auditLog)
    .where(buildWhere(filters, before))
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(requested);
  const items = rows.map(rowToEntry);
  const last = rows[rows.length - 1];
  // Only a FULL page can have more behind it. The cursor carries the
  // rendered timestamp plus the id, never `ts.toISOString()` — a JS
  // Date has already dropped the microseconds by the time it is here.
  const next_cursor =
    rows.length === requested && last
      ? formatAuditCursor({ ts: last.ts_cursor, id: last.id })
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
