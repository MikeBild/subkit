import { invalidParams } from "../transports/protocol-errors.ts";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;

interface CursorPayload {
  kind: string;
  offset: number;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(kind: string, cursor: string | undefined): CursorPayload {
  if (!cursor) return { kind, offset: 0 };
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.kind !== kind ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset === undefined ||
      parsed.offset < 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return { kind, offset: parsed.offset };
  } catch {
    throw invalidParams(`Invalid pagination cursor for ${kind}`);
  }
}

export function paginate<T>(
  kind: string,
  items: T[],
  cursor: string | undefined,
  pageSize = DEFAULT_PAGE_SIZE,
): { page: T[]; nextCursor?: string } {
  const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
  const decoded = decodeCursor(kind, cursor);
  const page = items.slice(decoded.offset, decoded.offset + size);
  const nextOffset = decoded.offset + page.length;
  return {
    page,
    ...(nextOffset < items.length
      ? { nextCursor: encodeCursor({ kind, offset: nextOffset }) }
      : {}),
  };
}

export const __test__ = { decodeCursor, encodeCursor };
