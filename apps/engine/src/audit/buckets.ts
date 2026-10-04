export type SizeBucket = "<1KB" | "<1MB" | "<10MB" | "<100MB" | ">=100MB";

export function bucketSize(bytes: number): SizeBucket {
  if (!Number.isFinite(bytes) || bytes < 1024) return "<1KB";
  if (bytes < 1024 * 1024) return "<1MB";
  if (bytes < 10 * 1024 * 1024) return "<10MB";
  if (bytes < 100 * 1024 * 1024) return "<100MB";
  return ">=100MB";
}
