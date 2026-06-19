// Size-bucket helper for low-cardinality audit metadata.
//
// Audit rows that carry a raw `size_bytes` field explode the
// cardinality of any SIEM / BI aggregation built on `metadata->>'size'`
// — one bucket per request. The files subsystem instead emits
// `size_bytes_bucket` ∈ five fixed strings, keyed off the byte count.
// Five buckets is enough resolution to chart "small attachments vs.
// huge uploads" without leaking per-row size.
//
// Quick truth table:
//   bucketSize(512)       === "<1KB"
//   bucketSize(2048)      === "<1MB"
//   bucketSize(900_000)   === "<1MB"
//   bucketSize(2_000_000) === "<10MB"
//   bucketSize(50_000_000)=== "<100MB"
//   bucketSize(2e9)       === ">=100MB"

export type SizeBucket = "<1KB" | "<1MB" | "<10MB" | "<100MB" | ">=100MB";

/** Map a byte count to a coarse size bucket suitable for audit metadata.
 *  Negative inputs are clamped to `<1KB` (defensive — the column is
 *  `bigint` non-negative at the DB layer). */
export function bucketSize(bytes: number): SizeBucket {
  if (!Number.isFinite(bytes) || bytes < 1024) return "<1KB";
  if (bytes < 1024 * 1024) return "<1MB";
  if (bytes < 10 * 1024 * 1024) return "<10MB";
  if (bytes < 100 * 1024 * 1024) return "<100MB";
  return ">=100MB";
}
