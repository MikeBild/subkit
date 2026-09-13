// Shared bucket grammar + window-cap validation for every /v1/stats/*
// route. The bucket axis (minute/hour/day/month/year) maps to
// `date_trunc(bucket, ts)`; the window caps reject scans that would
// explode the bucket count (and the cost of percentile_cont).
//
// Resolution + cap enforcement happen here once, server-side, so each
// route handler only deals with a validated, normalized window. The sk
// CLI re-implements the same caps client-side to fail fast, but the
// server remains the authority.

import { sql } from "drizzle-orm";

import type { Db } from "../../../db/client.ts";
import { BadRequestError } from "../../errors.ts";

export const BUCKET_UNITS = ["minute", "hour", "day", "month", "year"] as const;
export type BucketUnit = (typeof BUCKET_UNITS)[number];

/** Hard caps: maximum window span per bucket unit (in ms). Rejecting a
 *  wider window keeps the bucket count — and the percentile cost —
 *  bounded. */
const MS = { hour: 3_600_000, day: 86_400_000 };
export const WINDOW_CAP_MS: Record<BucketUnit, number> = {
  minute: 24 * MS.hour, // ≤ 24h  → 1440 buckets
  hour: 31 * MS.day, // ≤ 31d  → 744 buckets
  day: 366 * MS.day, // ≤ 366d
  month: 60 * 31 * MS.day, // ≤ ~60 months (generous upper bound)
  year: 10 * 366 * MS.day, // ≤ ~10 years
};

/** Validate an IANA timezone name via ICU. `date_trunc(..., ts at time
 *  zone $tz)` binds `tz` as a parameter, so this is not a SQL-injection
 *  guard — it exists so an unknown zone fails fast as a 400 instead of
 *  surfacing as a 500 from Postgres' "time zone not recognized". ICU's
 *  accepted set (canonical names + `Etc/*` + offset forms) is a superset
 *  of what Postgres rejects, so any tz that passes here either resolves
 *  in Postgres or — for the rare ICU/Postgres divergence — degrades to a
 *  clean query error, never a data leak. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const CAP_HINT: Record<BucketUnit, string> = {
  minute: "minute buckets span at most 24h; narrow --from or use --bucket hour",
  hour: "hour buckets span at most 31d; narrow --from or use --bucket day",
  day: "day buckets span at most 366d; narrow --from or use --bucket month",
  month: "month buckets span at most 60 months; narrow --from or use --bucket year",
  year: "year buckets span at most 10 years; narrow --from",
};

export interface ResolvedWindow {
  bucket: BucketUnit;
  from: Date;
  to: Date;
  tz: string;
  /** Set when `from` predated the tenant's audit-retention horizon and
   *  was clamped to it. Audit-backed routes surface this on the
   *  envelope so empty leading buckets read as "data aged out". */
  truncated_at?: string;
}

export interface RawWindowInput {
  bucket: string;
  from: string;
  to?: string | undefined;
  tz?: string | undefined;
}

/**
 * Parse + validate the common bucket window. Throws `BadRequestError`
 * with a stable `code` for the CLI/UI to branch on.
 */
export function resolveWindow(input: RawWindowInput): ResolvedWindow {
  if (!(BUCKET_UNITS as readonly string[]).includes(input.bucket)) {
    throw new BadRequestError(
      `invalid bucket '${input.bucket}'; expected one of ${BUCKET_UNITS.join(", ")}`,
      { reason: "bucket_invalid" },
    );
  }
  const bucket = input.bucket as BucketUnit;

  const from = new Date(input.from);
  if (Number.isNaN(from.getTime())) {
    throw new BadRequestError(`invalid 'from' timestamp '${input.from}'`, {
      reason: "from_invalid",
    });
  }
  const to = input.to ? new Date(input.to) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw new BadRequestError(`invalid 'to' timestamp '${input.to}'`, { reason: "to_invalid" });
  }
  if (to.getTime() <= from.getTime()) {
    throw new BadRequestError("'to' must be after 'from'", { reason: "window_empty" });
  }

  const span = to.getTime() - from.getTime();
  if (span > WINDOW_CAP_MS[bucket]) {
    throw new BadRequestError(CAP_HINT[bucket], { reason: "bucket_window_too_large" });
  }

  const tz = input.tz && input.tz.length > 0 ? input.tz : "UTC";
  if (!isValidTimezone(tz)) {
    throw new BadRequestError(`invalid timezone '${tz}'`, { reason: "tz_invalid" });
  }

  return { bucket, from, to, tz };
}

/**
 * Audit-backed routes (`/connectors`, `/events`) additionally clamp
 * `from` to the tenant's audit-retention horizon. There is no
 * `retention_days` config today, so the horizon is derived from the
 * oldest audit row for the tenant: anything before that has aged out of
 * the table. If the whole window predates the oldest row we reject;
 * otherwise we clamp `from` up and flag `truncated_at`.
 */
export async function clampToRetentionHorizon(
  db: Db,
  tenantId: string,
  win: ResolvedWindow,
): Promise<ResolvedWindow> {
  const row = (
    await db.execute(sql`select min(ts) as oldest from audit_log where tenant_id = ${tenantId}`)
  ).rows[0] as { oldest: string | null } | undefined;
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  if (!oldest) return win; // no audit rows yet — nothing to clamp against.

  if (win.from.getTime() >= oldest.getTime()) return win; // fully inside retention.

  if (win.to.getTime() <= oldest.getTime()) {
    throw new BadRequestError(
      `requested window ends before the tenant's audit-retention horizon (${oldest.toISOString()})`,
      { reason: "from_before_retention_horizon" },
    );
  }

  return { ...win, from: oldest, truncated_at: oldest.toISOString() };
}
