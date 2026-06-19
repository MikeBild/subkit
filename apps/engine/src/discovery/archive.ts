// Archive extraction for codebase discovery.
//
// Accepts a zip archive buffer, walks every entry, filters out paths
// that aren't worth analysing (node_modules, .git, lockfiles, binaries,
// huge files), and returns a list of {filename, buffer} pairs ready for
// `createDiscoveryRun`.
//
// Constraints:
//   - Total extracted bytes capped at 50 MB (sum across entries).
//   - Per-entry byte cap at 1 MB — prevents a single large binary
//     checked into a repo from dominating the run.
//   - Entry count capped at 500 (discovery run already caps at 50 files
//     for LLM analysis; the extra headroom lets us extract and then let
//     the service rank).

import yauzl from "yauzl";

export interface ExtractedFile {
  filename: string;
  buffer: Buffer;
  mime?: string;
}

export interface ArchiveExtractionResult {
  files: ExtractedFile[];
  skipped_count: number;
  skipped_reasons: Record<string, number>;
  total_bytes: number;
  truncated: boolean;
}

const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_PER_ENTRY_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_ENTRY_COUNT = 500;

/**
 * Path-based skip rules. Checked with `.startsWith(...)` and suffix
 * matches against the normalised (forward-slash) path. Matches here are
 * unambiguous noise — generated artifacts, lockfiles that add nothing
 * semantic, binary blobs.
 */
const SKIP_PREFIXES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".venv/",
  "__pycache__/",
  ".cache/",
  ".turbo/",
  "coverage/",
];

const SKIP_EXACT = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  ".DS_Store",
]);

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".jar",
  ".war",
  ".class",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".sqlite",
  ".db",
]);

function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function shouldSkip(path: string): string | null {
  const norm = normalise(path);
  if (norm.endsWith("/")) return "directory";
  for (const prefix of SKIP_PREFIXES) {
    if (norm.startsWith(prefix) || norm.includes(`/${prefix}`)) return "generated_dir";
  }
  const base = norm.split("/").pop() ?? norm;
  if (SKIP_EXACT.has(base)) return "lockfile_or_metadata";
  if (SKIP_EXTENSIONS.has(extensionOf(base))) return "binary_extension";
  return null;
}

export async function extractCodebaseArchive(buffer: Buffer): Promise<ArchiveExtractionResult> {
  return await new Promise<ArchiveExtractionResult>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("zip open returned no handle"));
        return;
      }
      const files: ExtractedFile[] = [];
      const skipped_reasons: Record<string, number> = {};
      let skipped_count = 0;
      let total_bytes = 0;
      let entry_count = 0;
      let truncated = false;

      const finish = (): void => {
        resolve({ files, skipped_count, skipped_reasons, total_bytes, truncated });
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
        if (entry_count > MAX_ENTRY_COUNT) {
          truncated = true;
          zipfile.close();
          finish();
          return;
        }
        const skip = shouldSkip(entry.fileName);
        if (skip) {
          noteSkip(skip);
          zipfile.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_PER_ENTRY_BYTES) {
          noteSkip("too_large");
          zipfile.readEntry();
          return;
        }
        if (total_bytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
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
            files.push({ filename: normalise(entry.fileName), buffer: content });
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
