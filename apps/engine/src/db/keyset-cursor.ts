// Keyset cursor for newest-first lists ordered by `(created_at DESC, id DESC)`.
//
// The cursor is OPAQUE to callers: `<ts>|<uuid>`, where `ts` is the column as
// Postgres rendered it (microseconds, UTC) and `uuid` the row id. Both halves
// are required. A timestamp alone skips every remaining member of a group of
// rows sharing one `created_at` (the audit log lost 6 rows of 15 that way),
// and a JS `Date` has already dropped the microseconds the column stores.
//
// Unlike an offset, the cursor is stable under inserts: a row written between
// two page fetches sorts before the cursor and neither shifts nor duplicates
// the rows behind it.

import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/** The cursor's shape. HTTP validators build their Zod pattern from it. */
export const KEYSET_CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface KeysetCursor {
  ts: string;
  id: string;
}

/** A value that is not a cursor this module minted. Thrown, never swallowed:
 *  answering "no cursor" would silently serve page one to a caller who asked
 *  for page five. */
export class InvalidKeysetCursorError extends Error {
  constructor(raw: string) {
    super(`invalid cursor: ${JSON.stringify(raw)}`);
    this.name = "InvalidKeysetCursorError";
  }
}

export function parseKeysetCursor(raw: string): KeysetCursor {
  const trimmed = raw.trim();
  if (!KEYSET_CURSOR_PATTERN.test(trimmed)) throw new InvalidKeysetCursorError(raw);
  const sep = trimmed.lastIndexOf("|");
  return { ts: trimmed.slice(0, sep), id: trimmed.slice(sep + 1) };
}

export function formatKeysetCursor(cursor: KeysetCursor): string {
  return `${cursor.ts}|${cursor.id}`;
}

/** Full-precision UTC rendering of a timestamptz column, selected alongside
 *  the row so the next cursor never round-trips through a JS `Date`. */
export function cursorTimestamp(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** "Strictly after the cursor" for `ORDER BY ts DESC, id DESC`. */
export function beforeKeyset(tsColumn: AnyColumn, idColumn: AnyColumn, cursor: KeysetCursor): SQL {
  return sql`(${tsColumn}, ${idColumn}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`;
}
