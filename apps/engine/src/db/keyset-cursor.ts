import { type AnyColumn, type SQL, sql } from "drizzle-orm";

export const KEYSET_CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface KeysetCursor {
  ts: string;
  id: string;
}

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

export function cursorTimestamp(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function beforeKeyset(tsColumn: AnyColumn, idColumn: AnyColumn, cursor: KeysetCursor): SQL {
  return sql`(${tsColumn}, ${idColumn}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`;
}
