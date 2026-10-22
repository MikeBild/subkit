import { and, gt, gte, isNull, or, type SQL } from "drizzle-orm";
import { sessions } from "../db/schema/identity.ts";

export const SESSION_SLIDING_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000;

export type BrowserSessionDenyReason = "revoked" | "expired_absolute" | "expired_sliding";

export interface BrowserSessionValidityRow {
  revoked_at: Date | null;
  absolute_expires_at: Date | null;
  last_seen_at: Date | null;
}

export function browserSessionDenyReason(
  row: BrowserSessionValidityRow,
  at: Date,
): BrowserSessionDenyReason | null {
  if (row.revoked_at) return "revoked";
  if (row.absolute_expires_at && row.absolute_expires_at.getTime() <= at.getTime())
    return "expired_absolute";
  if (row.last_seen_at && at.getTime() - row.last_seen_at.getTime() > SESSION_SLIDING_TTL_MS)
    return "expired_sliding";
  return null;
}

export function liveBrowserSessionWhere(at: Date): SQL | undefined {
  return and(
    isNull(sessions.revoked_at),
    or(isNull(sessions.absolute_expires_at), gt(sessions.absolute_expires_at, at)),
    or(
      isNull(sessions.last_seen_at),
      gte(sessions.last_seen_at, new Date(at.getTime() - SESSION_SLIDING_TTL_MS)),
    ),
  );
}
