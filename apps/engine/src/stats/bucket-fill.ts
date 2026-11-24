import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { BucketUnit } from "./bucket-units.ts";

export const BUCKET_FILLS = ["zero", "none"] as const;
export type BucketFill = (typeof BUCKET_FILLS)[number];

export interface BucketSeriesWindow {
  bucket: BucketUnit;
  from: Date;
  to: Date;
  tz: string;
}

export const bucketStartExpr = (column: SQL, bucket: BucketUnit, tz: string): SQL =>
  sql`(date_trunc(${bucket}, ${column} at time zone ${tz}) at time zone 'UTC')`;

export function fillBuckets<B extends { ts: string }>(
  keys: readonly string[],
  buckets: readonly B[],
  zero: (ts: string) => B,
): B[] {
  const byTs = new Map(buckets.map((bucket) => [bucket.ts, bucket]));
  const filled = keys.map((ts) => byTs.get(ts) ?? zero(ts));
  const known = new Set(keys);
  const strays = buckets.filter((bucket) => !known.has(bucket.ts));
  if (strays.length === 0) return filled;
  return [...filled, ...strays].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

export function fillGroups<G extends { buckets: B[] }, B extends { ts: string }>(
  groups: readonly G[],
  keys: readonly string[],
  zero: (ts: string) => B,
): G[] {
  return groups.map((group) => ({ ...group, buckets: fillBuckets(keys, group.buckets, zero) }));
}

export async function readBucketSeries(db: Db, w: BucketSeriesWindow): Promise<string[]> {
  const rows = (
    await db.execute(sql`
      select generate_series(
        date_trunc(${w.bucket}, ${w.from.toISOString()}::timestamptz at time zone ${w.tz}),
        (${w.to.toISOString()}::timestamptz at time zone ${w.tz}) - interval '1 microsecond',
        ('1 ' || ${w.bucket})::interval
      ) at time zone 'UTC' as bucket_ts
    `)
  ).rows as Record<string, unknown>[];
  return rows.map((row) => new Date(row.bucket_ts as string).toISOString());
}
