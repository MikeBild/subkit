// Generic ZIP entry walker over yauzl with injectable zip-bomb guards.
//
// Two consumers with different policies share this core:
//   - `discovery/archive.ts` — codebase archives; skips generated dirs,
//     lockfiles, binary extensions; tight per-entry cap (code files).
//   - `docs-ingestion/parsers/archive.ts` — document archives; keeps
//     binary documents (PDF/DOCX/…), generous per-entry cap.
//
// The walker enforces the caps and reports skips; WHAT to skip is the
// caller's policy via `shouldSkip`.

import yauzl from "yauzl";

export interface ZipWalkEntry {
  /** Normalised (forward-slash, no leading slash) entry path. */
  path: string;
  buffer: Buffer;
}

export interface ZipWalkOptions {
  /** Hard cap on entries visited; walking stops (truncated) beyond it. */
  maxEntries: number;
  /** Entries with a larger uncompressed size are skipped (`too_large`). */
  maxPerEntryBytes: number;
  /** Cumulative extracted-bytes cap; walking stops (truncated) beyond it. */
  maxTotalBytes: number;
  /** Policy hook: return a skip reason to drop the entry, null to keep.
   *  Receives the normalised path. Directory entries are always skipped
   *  (`directory`) before this hook runs. */
  shouldSkip?: (path: string) => string | null;
}

export interface ZipWalkResult {
  entries: ZipWalkEntry[];
  skipped_count: number;
  skipped_reasons: Record<string, number>;
  total_bytes: number;
  /** True when an entry-count or total-bytes cap stopped the walk early. */
  truncated: boolean;
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Walk every entry of a ZIP buffer, buffering kept entries in memory.
 *  Rejects on a malformed archive (yauzl open/parse error). */
export async function walkZipEntries(buffer: Buffer, opts: ZipWalkOptions): Promise<ZipWalkResult> {
  return await new Promise<ZipWalkResult>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("zip open returned no handle"));
        return;
      }
      const entries: ZipWalkEntry[] = [];
      const skipped_reasons: Record<string, number> = {};
      let skipped_count = 0;
      let total_bytes = 0;
      let entry_count = 0;
      let truncated = false;

      const finish = (): void => {
        resolve({ entries, skipped_count, skipped_reasons, total_bytes, truncated });
      };
      const noteSkip = (reason: string): void => {
        skipped_count += 1;
        skipped_reasons[reason] = (skipped_reasons[reason] ?? 0) + 1;
      };

      zipfile.on("error", (e) => {
        reject(e);
      });
      zipfile.on("end", () => finish());
      zipfile.on("entry", (entry: yauzl.Entry) => {
        entry_count += 1;
        if (entry_count > opts.maxEntries) {
          truncated = true;
          zipfile.close();
          finish();
          return;
        }
        const path = normalise(entry.fileName);
        if (path.endsWith("/")) {
          noteSkip("directory");
          zipfile.readEntry();
          return;
        }
        const skip = opts.shouldSkip?.(path) ?? null;
        if (skip) {
          noteSkip(skip);
          zipfile.readEntry();
          return;
        }
        if (entry.uncompressedSize > opts.maxPerEntryBytes) {
          noteSkip("too_large");
          zipfile.readEntry();
          return;
        }
        if (total_bytes + entry.uncompressedSize > opts.maxTotalBytes) {
          truncated = true;
          zipfile.close();
          finish();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            noteSkip("read_error");
            zipfile.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            const content = Buffer.concat(chunks);
            total_bytes += content.byteLength;
            entries.push({ path, buffer: content });
            zipfile.readEntry();
          });
          stream.on("error", () => {
            noteSkip("read_error");
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}
