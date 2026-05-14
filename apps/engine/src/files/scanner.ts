// File-scanner interface + default NoopScanner.
//
// The route-level upload path runs every uploaded file through
// `getScanner().scan(stream, meta)` before flipping the row to
// `status='ready'`. The default `NoopScanner` returns `clean` for
// every input — a real ClamAV-backed implementation (e.g. clamd via
// TCP) is a future operator concern. Shipping the interface now lets
// the upload path call into it unconditionally; operators who care
// about virus scanning swap the implementation behind `getScanner()`
// without touching the upload pipeline.

export interface ScanResult {
  /** "clean" gates the row to `status='ready'`; "infected" flips the
   *  row to `status='failed'` and emits a `FILE_SCAN_COMPLETED` audit
   *  event with the verdict + signature. */
  verdict: "clean" | "infected";
  /** Free-form engine identifier — "noop" for the default; "clamav"
   *  + a version string for a real backend. Surfaces in audit metadata
   *  so the operator can tell which engine produced a verdict. */
  engine: string;
  /** Optional signature / detection name for `"infected"` verdicts. */
  signature?: string;
}

export interface ScanMeta {
  content_type?: string | null;
  filename: string;
}

export interface FileScanner {
  scan(stream: AsyncIterable<Uint8Array>, meta: ScanMeta): Promise<ScanResult>;
}

/** Always-clean scanner. The fallback when no scanner backend is
 *  configured. */
export const NoopScanner: FileScanner = {
  async scan(_stream, _meta) {
    return { verdict: "clean", engine: "noop" };
  },
};

/** Resolve the configured scanner. Currently always returns
 *  `NoopScanner`; a future revision reads
 *  `getConfig().storage.scanner.*` and constructs a clamd client. */
export function getScanner(): FileScanner {
  return NoopScanner;
}
