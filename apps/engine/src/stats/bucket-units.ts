export const BUCKET_UNITS = ["minute", "hour", "day", "month", "year"] as const;
export type BucketUnit = (typeof BUCKET_UNITS)[number];

const MS = { hour: 3_600_000, day: 86_400_000 };
export const WINDOW_CAP_MS: Record<BucketUnit, number> = {
  minute: 24 * MS.hour,
  hour: 31 * MS.day,
  day: 366 * MS.day,
  month: 60 * 31 * MS.day,
  year: 10 * 366 * MS.day,
};
