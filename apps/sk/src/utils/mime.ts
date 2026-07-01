// Shared MIME map for sk CLI surfaces that upload local files.
//
// Single source of truth: `sk files upload`, `sk knowledge-sources
// create --file`, `sk discovery create --file`, REPL file-paste
// auto-upload, and the headless `--attach` flag all funnel through
// `detectMime(path)` before handing bytes to the engine. Duplicated
// extension tables in command files used to drift — this module is the
// one place that table lives now.

import { extname } from "node:path";

/** Filename-extension → IANA media type. Keys are lowercased with the
 *  leading dot. Anything not listed here falls back to
 *  `application/octet-stream`, which is the engine's accepted default
 *  for unknown blobs. Keep this list small and conservative; the engine
 *  performs its own scan + content-type sniffing on inline uploads. */
export const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Detect the MIME type for a local file path by extension. Returns
 * `application/octet-stream` for anything not in `MIME_MAP` — the engine
 * never trusts the client-asserted content-type for security decisions,
 * so a generous default is safe.
 */
export function detectMime(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
