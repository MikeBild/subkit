import type { Db } from "../../db/client.ts";
import { BadRequestError } from "../../http/errors.ts";
import { BUCKET_UNITS, type BucketUnit, WINDOW_CAP_MS } from "../../stats/bucket-units.ts";
import { oldestAuditTimestamp } from "../../stats/retention-horizon.ts";

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
  truncated_at?: string;
}

interface RawWindowInput {
  bucket: string;
  from: string;
  to?: string | undefined;
  tz?: string | undefined;
}

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

export async function clampToRetentionHorizon(
  db: Db,
  tenantId: string,
  win: ResolvedWindow,
): Promise<ResolvedWindow> {
  const oldest = await oldestAuditTimestamp(db, tenantId);
  if (!oldest) return win;

  if (win.from.getTime() >= oldest.getTime()) return win;

  if (win.to.getTime() <= oldest.getTime()) {
    throw new BadRequestError(
      `requested window ends before the tenant's audit-retention horizon (${oldest.toISOString()})`,
      { reason: "from_before_retention_horizon" },
    );
  }

  return { ...win, from: oldest, truncated_at: oldest.toISOString() };
}
