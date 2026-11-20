import { and, eq, gt, gte, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type CockpitInstallationKind,
  cockpitInstallations,
} from "../db/schema/cockpit-installations.ts";
import { sessions } from "../db/schema/identity.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const SESSION_SLIDING_TTL_MS = 8 * HOUR_MS;
export const SESSION_ABSOLUTE_TTL_MS = 24 * HOUR_MS;
export const DESKTOP_SESSION_SLIDING_TTL_MS = 30 * DAY_MS;
export const DESKTOP_SESSION_ABSOLUTE_TTL_MS = 90 * DAY_MS;

export interface SessionLifetime {
  sliding_ms: number;
  absolute_ms: number;
}

export function sessionLifetime(kind: CockpitInstallationKind | null | undefined): SessionLifetime {
  return kind === "desktop"
    ? { sliding_ms: DESKTOP_SESSION_SLIDING_TTL_MS, absolute_ms: DESKTOP_SESSION_ABSOLUTE_TTL_MS }
    : { sliding_ms: SESSION_SLIDING_TTL_MS, absolute_ms: SESSION_ABSOLUTE_TTL_MS };
}

export type BrowserSessionDenyReason = "revoked" | "expired_absolute" | "expired_sliding";

export interface BrowserSessionValidityRow {
  revoked_at: Date | null;
  expires_at: Date;
  absolute_expires_at: Date | null;
  last_seen_at: Date | null;
}

export function browserSessionDenyReason(
  row: BrowserSessionValidityRow,
  at: Date,
  slidingMs: number = SESSION_SLIDING_TTL_MS,
): BrowserSessionDenyReason | null {
  if (row.revoked_at) return "revoked";
  if (row.absolute_expires_at && row.absolute_expires_at.getTime() <= at.getTime())
    return "expired_absolute";
  const slidingExpired = row.last_seen_at
    ? at.getTime() - row.last_seen_at.getTime() > slidingMs
    : row.expires_at.getTime() <= at.getTime();
  return slidingExpired ? "expired_sliding" : null;
}

export function desktopSessionSql(): SQL {
  return sql`exists (select 1 from ${cockpitInstallations} as desktop_installation where desktop_installation.id = ${sql.raw('"sessions"."installation_id"')} and desktop_installation.tenant_id = ${sql.raw('"sessions"."tenant_id"')} and desktop_installation.kind = 'desktop')`;
}

export function sessionSlidingMsSql(): SQL {
  return sql`(case when ${desktopSessionSql()} then ${DESKTOP_SESSION_SLIDING_TTL_MS}::bigint else ${SESSION_SLIDING_TTL_MS}::bigint end)`;
}

export function liveBrowserSessionWhere(at: Date): SQL | undefined {
  return and(
    isNull(sessions.revoked_at),
    or(isNull(sessions.absolute_expires_at), gt(sessions.absolute_expires_at, at)),
    or(
      and(isNull(sessions.last_seen_at), gt(sessions.expires_at, at)),
      gte(sessions.last_seen_at, new Date(at.getTime() - SESSION_SLIDING_TTL_MS)),
      and(
        gte(sessions.last_seen_at, new Date(at.getTime() - DESKTOP_SESSION_SLIDING_TTL_MS)),
        desktopSessionSql(),
      ),
    ),
  );
}

export async function sessionSlidingMs(
  db: Pick<Db, "select">,
  tenantId: string,
  installationId: string | null | undefined,
): Promise<number> {
  if (!installationId) return SESSION_SLIDING_TTL_MS;
  const [installation] = await db
    .select({ kind: cockpitInstallations.kind })
    .from(cockpitInstallations)
    .where(
      and(
        eq(cockpitInstallations.tenant_id, tenantId),
        eq(cockpitInstallations.id, installationId),
      ),
    )
    .limit(1);
  return sessionLifetime(installation?.kind).sliding_ms;
}
