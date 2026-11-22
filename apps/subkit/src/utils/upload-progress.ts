export interface UploadProgressEvent {
  filename: string;
  fid: string;
  sent: number;
  total: number;
  elapsed_ms: number;
}

type UploadProgressSink = (event: UploadProgressEvent) => void;

export function readableFromBytes(
  bytes: Uint8Array,
  filename: string,
  fid: string,
  total: number,
  onProgress?: UploadProgressSink,
  chunkSize: number = 256 * 1024,
): ReadableStream<Uint8Array> {
  const startedAt = Date.now();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      controller.enqueue(chunk);
      offset = end;
      if (onProgress) {
        onProgress({
          filename,
          fid,
          sent: offset,
          total,
          elapsed_ms: Date.now() - startedAt,
        });
      }
    },
  });
}

export function renderProgressLine(ev: UploadProgressEvent): string {
  const pct = ev.total > 0 ? Math.min(100, Math.round((ev.sent / ev.total) * 100)) : 0;
  const sentH = humanBytes(ev.sent);
  const totalH = humanBytes(ev.total);
  const seconds = ev.elapsed_ms / 1000;
  const rate = seconds > 0 ? ev.sent / seconds : 0;
  const rateH = `${humanBytes(rate)}/s`;
  const remaining = Math.max(0, ev.total - ev.sent);
  const eta = rate > 0 ? remaining / rate : 0;
  const etaH = eta < 1 ? `${eta.toFixed(1)}s` : `${Math.round(eta)}s`;
  return `↑ ${ev.filename} ${sentH} / ${totalH} (${pct}%) · ${rateH} · ETA ${etaH}`;
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const unit = units[i] ?? "B";
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${unit}`;
}
