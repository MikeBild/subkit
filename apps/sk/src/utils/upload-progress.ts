// Byte-counter wrapper for presigned-PUT uploads.
//
// Two surfaces:
//   - TTY (human): a single status line that overwrites in place,
//       ↑ <filename> 45.2 MB / 100 MB · 32 MB/s · ETA 1.6s
//   - JSON / scripted: one structured event per chunk on stdout,
//       {"uploading": "fid_...", "sent": 47185920, "total": 104857600}
//
// The caller chooses the mode (TTY default, JSON when `--json` /
// `--output stream-json` / `--quiet`). The wrapper is mode-agnostic —
// it counts bytes and calls back per chunk. The actual rendering lives
// in the command surfaces that consume the events.

/** One progress observation. Cumulative `sent` against a known
 *  `total`, plus a monotonic elapsed millisecond timer the renderer can
 *  use to compute throughput + ETA without reaching for `Date.now()`. */
export interface UploadProgressEvent {
  filename: string;
  fid: string;
  sent: number;
  total: number;
  elapsed_ms: number;
}

export type UploadProgressSink = (event: UploadProgressEvent) => void;

/** Wrap a `Uint8Array` payload as a `ReadableStream<Uint8Array>` that
 *  reports cumulative bytes through `onProgress` once per chunk. Chunk
 *  size is fixed at 256 KiB — a balance between syscall overhead and
 *  visible progress cadence on a 10 GbE LAN. */
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

/** Format an `UploadProgressEvent` as a single-line TTY status string.
 *  Carries no terminal control codes — the caller wraps in `\r…` if it
 *  wants overwrite-in-place behaviour. */
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

/** Compact byte-count formatter — keeps two significant digits up to
 *  TB scale, identical to the convention `sk` uses elsewhere
 *  (executions, audit). Local copy avoids dragging the heavier
 *  `formatBytes` from cli-core into the upload hot path. */
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
